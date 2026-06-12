import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config.ts";

/**
 * Object storage abstraction (spec §6.2). One instance per bucket. The S3
 * implementation works against MinIO locally and AWS S3 in production —
 * same API, different endpoint.
 */
export interface FileStore {
  put(
    key: string,
    body: Uint8Array,
    opts?: { contentType?: string },
  ): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Object keys under `prefix`, lexicographically sorted. */
  list(prefix: string): Promise<string[]>;
  presignPut(
    key: string,
    opts?: { expiresInSeconds?: number; contentType?: string },
  ): Promise<string>;
  presignGet(
    key: string,
    opts?: { expiresInSeconds?: number },
  ): Promise<string>;
}

const DEFAULT_PRESIGN_EXPIRY = 15 * 60;

export class S3FileStore implements FileStore {
  constructor(private client: S3Client, private bucket: string) {}

  async put(
    key: string,
    body: Uint8Array,
    opts: { contentType?: string } = {},
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!res.Body) throw new Error(`empty body for s3://${this.bucket}/${key}`);
    return await res.Body.transformToByteArray();
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "NotFound" || err.name === "NoSuchKey")
      ) {
        return false;
      }
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return keys.sort();
  }

  presignPut(
    key: string,
    opts: { expiresInSeconds?: number; contentType?: string } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: opts.contentType,
      }),
      { expiresIn: opts.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRY },
    );
  }

  presignGet(
    key: string,
    opts: { expiresInSeconds?: number } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: opts.expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRY },
    );
  }
}

export function createS3Client(config: Config): S3Client {
  return new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
    // Path-style works for both MinIO and AWS; revisit if a bucket ever
    // requires virtual-hosted style (Phase 6).
    forcePathStyle: true,
  });
}

export function createFileStores(
  config: Config,
): { files: FileStore; backups: FileStore } {
  const client = createS3Client(config);
  return {
    files: new S3FileStore(client, config.S3_BUCKET_FILES),
    backups: new S3FileStore(client, config.S3_BUCKET_BACKUPS),
  };
}
