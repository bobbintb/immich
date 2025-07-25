import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetStatus } from 'src/enum';
import { DB } from 'src/schema';

export class TrashRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  getDeletedIds(): AsyncIterableIterator<{ id: string }> {
    return this.db.selectFrom('asset').select(['id']).where('status', '=', AssetStatus.DELETED).stream();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async restore(userId: string): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.TRASHED)
      .set({ status: AssetStatus.ACTIVE, deletedAt: null })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async empty(userId: string): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.TRASHED)
      .set({ status: AssetStatus.DELETED })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async restoreAll(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('status', '=', AssetStatus.TRASHED)
      .where('id', 'in', ids)
      .set({ status: AssetStatus.ACTIVE, deletedAt: null })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }
}
