# storage

`LocalStorage` keeps files in one folder (`STORAGE_DIR`, a Docker volume at `/data`):

```
/data
├── staging/<jobId>/chunk_000000.csv   # temporary chunk files (deleted after publish)
└── exports/<folder>/<file>.csv        # published files = the "customer destination"
```

In production, staging would be blob storage and the destination would be the customer's object storage or SFTP.
Keep the same three methods (`writeChunk`, `publish`, `removeStaging`) and swap the class.

**Every write is temp file → fsync → rename.** A rename is atomic on the same disk, so:

- nobody ever sees a half-written file;
- a retry replaces the file with identical content instead of creating a second one;
- two workers racing on the same chunk cannot corrupt it.

`publish` also returns a SHA-256 of the final file, stored on the artifact.
