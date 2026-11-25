// Verifies S3 access through the EC2 instance role. Never prints credentials.
//   npm run s3:check             -> resolves credentials via the default provider chain (no S3 request)
//   npm run s3:check -- --write  -> also PUTs, GETs and DELETEs tiny objects under _healthcheck/ and thumbnail/_healthcheck/
import { env } from "../src/config/env.js";
import { checkS3Credentials, deleteObject, getObject, presignGetUrl, putObject, putObjectIfAbsent } from "../src/services/s3.service.js";

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
    // Display copies and thumbnails: written, read back as the API streams them, and a missing one must be a plain 404
    const image = `thumbnail/${key}`;
    await putObject({ key: image, body, contentType: "text/plain" });
    const read = await getObject(image);
    if ((await read?.Body.transformToString()) !== body) throw new Error("thumbnail/ object could not be read back");
    await deleteObject(image);
    console.log("✔ thumbnail/ images: PutObject, GetObject, DeleteObject");
    await getObject(image).then(
      () => console.log("✔ a missing image answers 404"),
      () => console.warn("! a missing image answers 403: grant the role s3:ListBucket on the bucket"),
    );
    await deleteObject(key);
    console.log("✔ s3:DeleteObject (test object removed)");
  } catch (err) {
    console.error(`✘ ${err.code ?? ""} ${err.message} — see the server log lines above for the missing permission`);
    process.exit(1);
  }
} else {
  console.log("Run with -- --write to test upload, presigned download and cleanup.");
}
