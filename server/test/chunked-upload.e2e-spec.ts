import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from 'src/app.module';
import { ImmichConfigService } from 'src/services/immich-config.service';
import { ImmichConfig } from 'src/services/immich-config.service';
import request from 'supertest';
import { createReadStream } from 'fs';
import { sync } from 'rimraf';
import { randomBytes } from 'crypto';
import { APP_MEDIA_LOCATION } from 'src/constants';
import { LoginResponseDto } from 'src/dtos/auth.dto';
import { AssetMediaResponseDto, AssetMediaStatus } from 'src/dtos/asset-media-response.dto';
import { AssetType } from 'src/enum';

const UPLOAD_PATH = `${APP_MEDIA_LOCATION}/upload/admin`;

describe('Chunked Upload (e2e)', () => {
  let app: INestApplication;
  let server: any;
  let loginResponse: LoginResponseDto;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ImmichConfigService)
      .useValue({
        config: {
          upload: {
            // temp location for this test
            location: UPLOAD_PATH,
          },
        } as ImmichConfig,
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    server = app.getHttpServer();

    // Login
    const { body } = await request(server).post('/auth/login').send({
      email: 'testuser@email.com',
      password: 'password',
    });
    loginResponse = body;
  });

  afterAll(async () => {
    await app.close();
    sync(UPLOAD_PATH);
  });

  it('should upload a file in chunks', async () => {
    const fileSize = 10 * 1024 * 1024; // 10MB
    const chunkSize = 1 * 1024 * 1024; // 1MB
    const filePath = `${UPLOAD_PATH}/test.jpg`;
    const file = randomBytes(fileSize);

    // Create a dummy file
    require('fs').writeFileSync(filePath, file);

    const asset: AssetMediaResponseDto = {
      id: '',
      status: AssetMediaStatus.CREATED,
    };

    for (let i = 0; i < fileSize / chunkSize; i++) {
      const start = i * chunkSize;
      const end = start + chunkSize - 1;
      const chunk = createReadStream(filePath, { start, end });

      const { body } = await request(server)
        .post('/assets')
        .set('Authorization', `Bearer ${loginResponse.accessToken}`)
        .set('Content-Range', `bytes ${start}-${end}/${fileSize}`)
        .attach('assetData', chunk, {
          filename: 'test.jpg',
          contentType: 'image/jpeg',
        })
        .field('deviceAssetId', 'test-asset-id')
        .field('deviceId', 'test-device-id')
        .field('fileCreatedAt', new Date().toISOString())
        .field('fileModifiedAt', new Date().toISOString());

      if (body.id) {
        asset.id = body.id;
      }
    }

    expect(asset.id).toBeDefined();

    // Verify that the asset was created in the database
    const { body: assetData } = await request(server)
      .get(`/assets/${asset.id}`)
      .set('Authorization', `Bearer ${loginResponse.accessToken}`);

    expect(assetData).toBeDefined();
    expect(assetData.type).toEqual(AssetType.IMAGE);
    expect(assetData.originalPath).toContain('test.jpg');
  });
});
