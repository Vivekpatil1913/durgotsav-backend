// Short CDN/browser caching for public read endpoints that change slowly
export const cache = (seconds) => (req, res, next) => {
  res.set("Cache-Control", `public, max-age=${seconds}, stale-while-revalidate=${seconds * 4}`);
  next();
};
