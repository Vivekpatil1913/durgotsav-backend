// Runs inside a worker thread of certificate.render-pool.js: renders one certificate (or one bundle) per message.
import { parentPort } from "node:worker_threads";
import { CertificateDataError, renderCertificateImage, renderCertificatePdf, renderCertificatesPdf } from "./certificate.renderer.js";

const RENDER = {
  pdf: (job) => renderCertificatePdf(job.cert, job.options),
  image: (job) => renderCertificateImage(job.cert, job.options),
  bundle: (job) => renderCertificatesPdf(job.certs, job.options),
};

parentPort.on("message", async (job) => {
  try {
    parentPort.postMessage({ id: job.id, data: await RENDER[job.kind](job) });
  } catch (err) {
    parentPort.postMessage({ id: job.id, error: { message: err.message, code: err.code, data: err instanceof CertificateDataError } });
  }
});
