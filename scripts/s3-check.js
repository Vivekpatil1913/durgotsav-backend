// Verifies S3 access through the EC2 instance role. Never prints credentials.
//   npm run s3:check             -> resolves credentials via the default provider chain (no S3 request)
//   npm run s3:check -- --write  -> also PUTs, presigned-GETs and DELETEs one tiny object under _healthcheck/
import { env } from "../src/config/env.js";
import { checkS3Credentials, deleteObject, presignGetUrl, putObjectIfAbsent } from "../src/services/s3.service.js";

console.log(`Bucket: ${env.AWS_S3_BUCKET_NAME || "(not set)"} · Region: ${env.AWS_REGION} · Storage mode: ${env.PARTICIPANT_IMAGE_STORAGE}`);
if (!env.AWS_S3_BUCKET_NAME) {
  console.error("AWS_S3_BUCKET_NAME is empty — see backend/.env.example");
  process.exit(1);
}

if (!(await checkS3Credentials())) process.exit(1);
console.log("✔ Credentials resolved from the default provider chain");

if (process.argv.includes("--write")) {
  const key = `_healthcheck/${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  const body = `durgotsav s3 check ${Date.now()}`;
  try {
    await putObjectIfAbsent({ key, body, contentType: "text/plain" });
    console.log(`✔ s3:PutObject ${key}`);
    const { url } = await presignGetUrl(key);
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok || text !== body) throw new Error(`presigned GET returned HTTP ${res.status}`);
    console.log(`✔ s3:GetObject via presigned URL (expires in ${env.AWS_S3_PRESIGNED_URL_EXPIRY_SECONDS}s)`);
    await deleteObject(key);
    console.log("✔ s3:DeleteObject (test object removed)");
  } catch (err) {
    console.error(`✘ ${err.code ?? ""} ${err.message} — see the server log lines above for the missing permission`);
    process.exit(1);
  }
} else {
  console.log("Run with -- --write to test upload, presigned download and cleanup.");
}
