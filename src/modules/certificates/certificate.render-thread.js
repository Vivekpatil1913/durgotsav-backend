// Runs inside a worker thread of certificate.render-pool.js: renders one certificate per message.
import { parentPort } from "node:worker_threads";
import { CertificateDataError, renderCertificatePdf } from "./certificate.renderer.js";

parentPort.on("message", async ({ id, cert, options }) => {
  try {
    parentPort.postMessage({ id, pdf: await renderCertificatePdf(cert, options) });
  } catch (err) {
    parentPort.postMessage({ id, error: { message: err.message, code: err.code, data: err instanceof CertificateDataError } });
  }
});
