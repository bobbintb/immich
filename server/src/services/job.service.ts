import { BadRequestException, Injectable } from '@nestjs/common';
import { ClassConstructor } from 'class-transformer';
import { snakeCase } from 'lodash';
import { SystemConfig } from 'src/config';
import { OnEvent } from 'src/decorators';
import { mapAsset } from 'src/dtos/asset-response.dto';
import { AllJobStatusResponseDto, JobCommandDto, JobCreateDto, JobStatusDto } from 'src/dtos/job.dto';
import {
  AssetType,
  AssetVisibility,
  BootstrapEventPriority,
  CronJob,
  DatabaseLock,
  ImmichWorker,
  JobCommand,
  JobName,
  JobStatus,
  ManualJobName,
  QueueCleanType,
  QueueName,
} from 'src/enum';
import { ArgOf, ArgsOf } from 'src/repositories/event.repository';
import { BaseService } from 'src/services/base.service';
import { ConcurrentQueueName, JobItem } from 'src/types';
import { hexOrBufferToBase64 } from 'src/utils/bytes';
import { handlePromiseError } from 'src/utils/misc';

const asJobItem = (dto: JobCreateDto): JobItem => {
  switch (dto.name) {
    case ManualJobName.TAG_CLEANUP: {
      return { name: JobName.TAG_CLEANUP };
    }

    case ManualJobName.PERSON_CLEANUP: {
      return { name: JobName.PERSON_CLEANUP };
    }

    case ManualJobName.USER_CLEANUP: {
      return { name: JobName.USER_DELETE_CHECK };
    }

    case ManualJobName.MEMORY_CLEANUP: {
      return { name: JobName.MEMORIES_CLEANUP };
    }

    case ManualJobName.MEMORY_CREATE: {
      return { name: JobName.MEMORIES_CREATE };
    }

    case ManualJobName.BACKUP_DATABASE: {
      return { name: JobName.BACKUP_DATABASE };
    }

    default: {
      throw new BadRequestException('Invalid job name');
    }
  }
};

const asNightlyTasksCron = (config: SystemConfig) => {
  const [hours, minutes] = config.nightlyTasks.startTime.split(':').map(Number);
  return `${minutes} ${hours} * * *`;
};

@Injectable()
export class JobService extends BaseService {
  private services: ClassConstructor<unknown>[] = [];
  private nightlyJobsLock = false;

  @OnEvent({ name: 'config.init' })
  async onConfigInit({ newConfig: config }: ArgOf<'config.init'>) {
    if (this.worker === ImmichWorker.MICROSERVICES) {
      this.updateQueueConcurrency(config);
      return;
    }

    this.nightlyJobsLock = await this.databaseRepository.tryLock(DatabaseLock.NightlyJobs);
    if (this.nightlyJobsLock) {
      const cronExpression = asNightlyTasksCron(config);
      this.logger.debug(`Scheduling nightly jobs for ${cronExpression}`);
      this.cronRepository.create({
        name: CronJob.NightlyJobs,
        expression: cronExpression,
        start: true,
        onTick: () => handlePromiseError(this.handleNightlyJobs(), this.logger),
      });
    }
  }

  @OnEvent({ name: 'config.update', server: true })
  onConfigUpdate({ newConfig: config }: ArgOf<'config.update'>) {
    if (this.worker === ImmichWorker.MICROSERVICES) {
      this.updateQueueConcurrency(config);
      return;
    }

    if (this.nightlyJobsLock) {
      const cronExpression = asNightlyTasksCron(config);
      this.logger.debug(`Scheduling nightly jobs for ${cronExpression}`);
      this.cronRepository.update({ name: CronJob.NightlyJobs, expression: cronExpression, start: true });
    }
  }

  @OnEvent({ name: 'app.bootstrap', priority: BootstrapEventPriority.JobService })
  onBootstrap() {
    this.jobRepository.setup(this.services);
    if (this.worker === ImmichWorker.MICROSERVICES) {
      this.jobRepository.startWorkers();
    }
  }

  private updateQueueConcurrency(config: SystemConfig) {
    this.logger.debug(`Updating queue concurrency settings`);
    for (const queueName of Object.values(QueueName)) {
      let concurrency = 1;
      if (this.isConcurrentQueue(queueName)) {
        concurrency = config.job[queueName].concurrency;
      }
      this.logger.debug(`Setting ${queueName} concurrency to ${concurrency}`);
      this.jobRepository.setConcurrency(queueName, concurrency);
    }
  }

  setServices(services: ClassConstructor<unknown>[]) {
    this.services = services;
  }

  async create(dto: JobCreateDto): Promise<void> {
    await this.jobRepository.queue(asJobItem(dto));
  }

  async handleCommand(queueName: QueueName, dto: JobCommandDto): Promise<JobStatusDto> {
    this.logger.debug(`Handling command: queue=${queueName},command=${dto.command},force=${dto.force}`);

    switch (dto.command) {
      case JobCommand.START: {
        await this.start(queueName, dto);
        break;
      }

      case JobCommand.PAUSE: {
        await this.jobRepository.pause(queueName);
        break;
      }

      case JobCommand.RESUME: {
        await this.jobRepository.resume(queueName);
        break;
      }

      case JobCommand.EMPTY: {
        await this.jobRepository.empty(queueName);
        break;
      }

      case JobCommand.CLEAR_FAILED: {
        const failedJobs = await this.jobRepository.clear(queueName, QueueCleanType.FAILED);
        this.logger.debug(`Cleared failed jobs: ${failedJobs}`);
        break;
      }
    }

    return this.getJobStatus(queueName);
  }

  async getJobStatus(queueName: QueueName): Promise<JobStatusDto> {
    const [jobCounts, queueStatus] = await Promise.all([
      this.jobRepository.getJobCounts(queueName),
      this.jobRepository.getQueueStatus(queueName),
    ]);

    return { jobCounts, queueStatus };
  }

  async getAllJobsStatus(): Promise<AllJobStatusResponseDto> {
    const response = new AllJobStatusResponseDto();
    for (const queueName of Object.values(QueueName)) {
      response[queueName] = await this.getJobStatus(queueName);
    }
    return response;
  }

  private async start(name: QueueName, { force }: JobCommandDto): Promise<void> {
    const { isActive } = await this.jobRepository.getQueueStatus(name);
    if (isActive) {
      throw new BadRequestException(`Job is already running`);
    }

    this.telemetryRepository.jobs.addToCounter(`immich.queues.${snakeCase(name)}.started`, 1);

    switch (name) {
      case QueueName.VIDEO_CONVERSION: {
        return this.jobRepository.queue({ name: JobName.QUEUE_VIDEO_CONVERSION, data: { force } });
      }

      case QueueName.STORAGE_TEMPLATE_MIGRATION: {
        return this.jobRepository.queue({ name: JobName.STORAGE_TEMPLATE_MIGRATION });
      }

      case QueueName.MIGRATION: {
        return this.jobRepository.queue({ name: JobName.QUEUE_MIGRATION });
      }

      case QueueName.SMART_SEARCH: {
        return this.jobRepository.queue({ name: JobName.QUEUE_SMART_SEARCH, data: { force } });
      }

      case QueueName.DUPLICATE_DETECTION: {
        return this.jobRepository.queue({ name: JobName.QUEUE_DUPLICATE_DETECTION, data: { force } });
      }

      case QueueName.METADATA_EXTRACTION: {
        return this.jobRepository.queue({ name: JobName.QUEUE_METADATA_EXTRACTION, data: { force } });
      }

      case QueueName.SIDECAR: {
        return this.jobRepository.queue({ name: JobName.QUEUE_SIDECAR, data: { force } });
      }

      case QueueName.THUMBNAIL_GENERATION: {
        return this.jobRepository.queue({ name: JobName.QUEUE_GENERATE_THUMBNAILS, data: { force } });
      }

      case QueueName.FACE_DETECTION: {
        return this.jobRepository.queue({ name: JobName.QUEUE_FACE_DETECTION, data: { force } });
      }

      case QueueName.FACIAL_RECOGNITION: {
        return this.jobRepository.queue({ name: JobName.QUEUE_FACIAL_RECOGNITION, data: { force } });
      }

      case QueueName.LIBRARY: {
        return this.jobRepository.queue({ name: JobName.LIBRARY_QUEUE_SCAN_ALL, data: { force } });
      }

      case QueueName.BACKUP_DATABASE: {
        return this.jobRepository.queue({ name: JobName.BACKUP_DATABASE, data: { force } });
      }

      default: {
        throw new BadRequestException(`Invalid job name: ${name}`);
      }
    }
  }

  @OnEvent({ name: 'job.start' })
  async onJobStart(...[queueName, job]: ArgsOf<'job.start'>) {
    const queueMetric = `immich.queues.${snakeCase(queueName)}.active`;
    this.telemetryRepository.jobs.addToGauge(queueMetric, 1);
    try {
      const status = await this.jobRepository.run(job);
      const jobMetric = `immich.jobs.${job.name.replaceAll('-', '_')}.${status}`;
      this.telemetryRepository.jobs.addToCounter(jobMetric, 1);
      if (status === JobStatus.SUCCESS || status == JobStatus.SKIPPED) {
        await this.onDone(job);
      }
    } catch (error: Error | any) {
      await this.eventRepository.emit('job.failed', { job, error });
    } finally {
      this.telemetryRepository.jobs.addToGauge(queueMetric, -1);
    }
  }

  private isConcurrentQueue(name: QueueName): name is ConcurrentQueueName {
    return ![
      QueueName.FACIAL_RECOGNITION,
      QueueName.STORAGE_TEMPLATE_MIGRATION,
      QueueName.DUPLICATE_DETECTION,
      QueueName.BACKUP_DATABASE,
    ].includes(name);
  }

  async handleNightlyJobs() {
    const config = await this.getConfig({ withCache: false });
    const jobs: JobItem[] = [];

    if (config.nightlyTasks.databaseCleanup) {
      jobs.push(
        { name: JobName.ASSET_DELETION_CHECK },
        { name: JobName.USER_DELETE_CHECK },
        { name: JobName.PERSON_CLEANUP },
        { name: JobName.MEMORIES_CLEANUP },
        { name: JobName.CLEAN_OLD_SESSION_TOKENS },
        { name: JobName.CLEAN_OLD_AUDIT_LOGS },
      );
    }

    if (config.nightlyTasks.generateMemories) {
      jobs.push({ name: JobName.MEMORIES_CREATE });
    }

    if (config.nightlyTasks.syncQuotaUsage) {
      jobs.push({ name: JobName.USER_SYNC_USAGE });
    }

    if (config.nightlyTasks.missingThumbnails) {
      jobs.push({ name: JobName.QUEUE_GENERATE_THUMBNAILS, data: { force: false } });
    }

    if (config.nightlyTasks.clusterNewFaces) {
      jobs.push({ name: JobName.QUEUE_FACIAL_RECOGNITION, data: { force: false, nightly: true } });
    }

    await this.jobRepository.queueAll(jobs);
  }

  /**
   * Queue follow up jobs
   */
  private async onDone(item: JobItem) {
    switch (item.name) {
      case JobName.SIDECAR_SYNC:
      case JobName.SIDECAR_DISCOVERY: {
        await this.jobRepository.queue({ name: JobName.METADATA_EXTRACTION, data: item.data });
        break;
      }

      case JobName.SIDECAR_WRITE: {
        await this.jobRepository.queue({
          name: JobName.METADATA_EXTRACTION,
          data: { id: item.data.id, source: 'sidecar-write' },
        });
        break;
      }

      case JobName.STORAGE_TEMPLATE_MIGRATION_SINGLE: {
        if (item.data.source === 'upload' || item.data.source === 'copy') {
          await this.jobRepository.queue({ name: JobName.GENERATE_THUMBNAILS, data: item.data });
        }
        break;
      }

      case JobName.GENERATE_PERSON_THUMBNAIL: {
        const { id } = item.data;
        const person = await this.personRepository.getById(id);
        if (person) {
          this.eventRepository.clientSend('on_person_thumbnail', person.ownerId, person.id);
        }
        break;
      }

      case JobName.GENERATE_THUMBNAILS: {
        if (!item.data.notify && item.data.source !== 'upload') {
          break;
        }

        const [asset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([item.data.id]);
        if (!asset) {
          this.logger.warn(`Could not find asset ${item.data.id} after generating thumbnails`);
          break;
        }

        const jobs: JobItem[] = [
          { name: JobName.SMART_SEARCH, data: item.data },
          { name: JobName.FACE_DETECTION, data: item.data },
        ];

        if (asset.type === AssetType.VIDEO) {
          jobs.push({ name: JobName.VIDEO_CONVERSION, data: item.data });
        }

        await this.jobRepository.queueAll(jobs);
        if (asset.visibility === AssetVisibility.TIMELINE || asset.visibility === AssetVisibility.ARCHIVE) {
          this.eventRepository.clientSend('on_upload_success', asset.ownerId, mapAsset(asset));
          if (asset.exifInfo) {
            const exif = asset.exifInfo;
            this.eventRepository.clientSend('AssetUploadReadyV1', asset.ownerId, {
              // TODO remove `on_upload_success` and then modify the query to select only the required fields)
              asset: {
                id: asset.id,
                ownerId: asset.ownerId,
                originalFileName: asset.originalFileName,
                thumbhash: asset.thumbhash ? hexOrBufferToBase64(asset.thumbhash) : null,
                checksum: hexOrBufferToBase64(asset.checksum),
                fileCreatedAt: asset.fileCreatedAt,
                fileModifiedAt: asset.fileModifiedAt,
                localDateTime: asset.localDateTime,
                duration: asset.duration,
                type: asset.type,
                deletedAt: asset.deletedAt,
                isFavorite: asset.isFavorite,
                visibility: asset.visibility,
                livePhotoVideoId: asset.livePhotoVideoId,
                stackId: asset.stackId,
              },
              exif: {
                assetId: exif.assetId,
                description: exif.description,
                exifImageWidth: exif.exifImageWidth,
                exifImageHeight: exif.exifImageHeight,
                fileSizeInByte: exif.fileSizeInByte,
                orientation: exif.orientation,
                dateTimeOriginal: exif.dateTimeOriginal,
                modifyDate: exif.modifyDate,
                timeZone: exif.timeZone,
                latitude: exif.latitude,
                longitude: exif.longitude,
                projectionType: exif.projectionType,
                city: exif.city,
                state: exif.state,
                country: exif.country,
                make: exif.make,
                model: exif.model,
                lensModel: exif.lensModel,
                fNumber: exif.fNumber,
                focalLength: exif.focalLength,
                iso: exif.iso,
                exposureTime: exif.exposureTime,
                profileDescription: exif.profileDescription,
                rating: exif.rating,
                fps: exif.fps,
              },
            });
          }
        }

        break;
      }

      case JobName.SMART_SEARCH: {
        if (item.data.source === 'upload') {
          await this.jobRepository.queue({ name: JobName.DUPLICATE_DETECTION, data: item.data });
        }
        break;
      }

      case JobName.USER_DELETION: {
        this.eventRepository.clientBroadcast('on_user_delete', item.data.id);
        break;
      }
    }
  }
}
