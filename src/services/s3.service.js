// Amazon S3 access for private participant originals.
// Credentials come from the AWS SDK default provider chain — on EC2 that is the instance role (IMDS).
// No access keys are read or passed here, and credentials are never logged.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const client = new S3Client({ region: env.AWS_REGION || "ap-south-1" });

// Indirection so tests can stub the network calls without touching the real client
export const s3Transport = {
  send: (command) => client.send(command),
  presign: (command, options) => getSignedUrl(client, command, options),
  credentials: () => client.config.credentials(),
};

export const bucket = () => env.AWS_S3_BUCKET_NAME;

// Thrown when IfNoneMatch: "*" finds an object already at the key — the caller picks the next number
export class ObjectExistsError extends Error {}

const TROUBLESHOOTING = [
  "check that an IAM role is attached to this EC2 instance (EC2 console > Actions > Security > Modify IAM role)",
  "check that instance metadata (IMDS) is enabled; use hop limit 2 if the API runs in a container",
  "check that AWS_ACCESS_KEY_ID / AWS_PROFILE are NOT set for the app process, so the instance role is used",
].join("; ");

const UNAVAILABLE = "Photo storage is temporarily unavailable. Please try again in a few minutes.";
const httpStatus = (err) => err?.$metadata?.httpStatusCode;

function operationalError(err, action, key) {
  const resource = `arn:aws:s3:::${bucket()}${key ? `/${key}` : ""}`;
  if (err?.name === "CredentialsProviderError" || (!httpStatus(err) && /credential/i.test(err?.message ?? ""))) {
    logger.error({ errName: err?.name, action }, `S3: could not obtain credentials from the default provider chain: ${TROUBLESHOOTING}`);
    return new AppError(503, UNAVAILABLE, { code: "S3_CREDENTIALS_UNAVAILABLE" });
  }
  if (err?.name === "AccessDenied" || httpStatus(err) === 403) {
    logger.error({ action, resource }, `S3: access denied — the EC2 instance role needs ${action} on ${resource}`);
    return new AppError(503, UNAVAILABLE, { code: "S3_ACCESS_DENIED" });
  }
  if (err?.name === "NoSuchBucket") {
    logger.error({ bucket: bucket(), region: env.AWS_REGION }, "S3: bucket not found — check AWS_S3_BUCKET_NAME and AWS_REGION");
    return new AppError(503, UNAVAILABLE, { code: "S3_BUCKET_NOT_FOUND" });
  }
  logger.error({ errName: err?.name, status: httpStatus(err), action, resource }, "S3 request failed");
  return new AppError(502, "We could not save your photo right now. Please try again.", { code: "S3_UNAVAILABLE" });
}

// Uploads only if nothing exists at the key yet (S3 conditional write), so an object is never overwritten.
export async function putObjectIfAbsent({ key, body, contentType, metadata }) {
  try {
    await s3Transport.send(new PutObjectCommand({
      Bucket: bucket(), Key: key, Body: body, ContentType: contentType, Metadata: metadata, IfNoneMatch: "*",
    }));
  } catch (err) {
    // 412: an object exists; 409: a concurrent conditional write to the same key is in flight
    if (err?.name === "PreconditionFailed" || [409, 412].includes(httpStatus(err))) throw new ObjectExistsError(key);
    throw operationalError(err, "s3:PutObject", key);
  }
}

export async function deleteObject(key) {
  try {
    await s3Transport.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (err) {
    throw operationalError(err, "s3:DeleteObject", key);
  }
}

// Short-lived GET link for a private object. The browser only ever sees the signed URL.
export async function presignGetUrl(key, { filename } = {}) {
  const expiresIn = env.AWS_S3_PRESIGNED_URL_EXPIRY_SECONDS;
  try {
    const url = await s3Transport.presign(new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: filename ? `inline; filename*=UTF-8''${encodeURIComponent(filename)}` : undefined,
    }), { expiresIn });
    return { url, expires_at: new Date(Date.now() + expiresIn * 1000).toISOString() };
  } catch (err) {
    throw operationalError(err, "s3:GetObject", key);
  }
}

// Startup self-check: resolves credentials through the default chain (no S3 call; nothing secret is logged).
export async function checkS3Credentials() {
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) {
    logger.warn("S3: AWS_ACCESS_KEY_ID / AWS_PROFILE is set for this process, so the SDK uses it instead of the EC2 instance role. Remove it on EC2.");
  }
  try {
    const creds = await s3Transport.credentials();
    logger.info({ bucket: bucket(), region: env.AWS_REGION, temporary: Boolean(creds.sessionToken) },
      "S3: credentials resolved via the default provider chain");
    return true;
  } catch (err) {
    operationalError(err, "credentials");
    return false;
  }
}
