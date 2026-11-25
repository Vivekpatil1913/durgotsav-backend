# Participant photo storage

With `PARTICIPANT_IMAGE_STORAGE=s3` no participant photo is written to the server's disk:

| What | S3 key | Database (`registration_photos`) |
|---|---|---|
| Original as uploaded (EXIF/GPS intact, private) | `DD-MM-YYYY/<First>_<Last>_<Mobile>/<First>_<Last>_<Mobile> (n).<ext>` — unchanged | `storage_key`, `photo_no` |
| Display copy, WebP ≤ 1600 px, ≤ 300 KB | `thumbnail/registrations/YYYY-MM/<random>.webp` | `image_path` = S3 URL |
| Thumbnail, WebP ≤ 480 px, ≤ 100 KB | `thumbnail/registrations/YYYY-MM/<random>_t.webp` | `thumb_path` = S3 URL |

The `thumbnail/` folder needs no setup: S3 creates it with the first object. Its keys hold no names or mobile numbers,
because they end up in public page addresses.

**Reading.** The bucket is private, so API responses keep carrying `/uploads/registrations/…` as before, whichever form
the database holds. `GET /uploads/…` serves the file from the server's disk if it is there (photos from before S3), and
otherwise streams it from S3: `thumbnail/registrations/…`, then `uploads/registrations/…`, then `registrations/…` (files
copied to S3 by hand with or without their `uploads/` folder). Nothing outside `registrations/YYYY-MM/*.webp` is ever
served, so originals cannot be reached this way. nginx must pass `/uploads/` to Node.

**Failures.** A thumbnail that cannot be made or stored is replaced by the display copy (and the other way round). If
neither can be stored, or the original cannot, the registration fails with the same "try again" answer as before and
whatever was uploaded is removed. A photo that cannot be decoded at all is refused as before. HEIC is refused by name.

CMS images (forts, testimonials, …) are stored in `uploads/` as before.

**Permissions.** The role needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on the bucket's objects, including
`thumbnail/*`. With `s3:ListBucket` on the bucket, a missing image answers 404 instead of 403. Check before restarting:

```
npm run s3:check -- --write
```

`UPLOAD_MAX_MB` in `.env` overrides the default of 20; nginx `client_max_body_size` must allow it.
