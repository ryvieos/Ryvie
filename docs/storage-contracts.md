# Ryvie Storage JSON Contracts (Step 0)

This document specifies the stable JSON contracts for the Storage subsystem. All outputs are strict JSON.

## Disk
- id: string (stable, e.g. `/dev/disk/by-id/…`)
- device: string (e.g. `sda`, `nvme0n1`)
- sizeBytes: number
- sizeHuman: string
- isSystem: boolean
- isMounted: boolean
- mountpoint: string | null
- health: string (e.g. `good|warn|bad|unknown`)
- partitions: Array<{ path: string, sizeBytes: number, fs: string | null, type: string | null }>

## Proposal
Request body:
```json
{ "diskIds": ["by-id-1", "by-id-2", "by-id-3"] }
```
Response:
```json
{
  "selectedDisks": ["by-id-1", "by-id-2"],
  "suggested": "auto|raid1|raid5|shr-like",
  "capacityBytes": 0,
  "faultTolerance": 0,
  "planPreview": [
    { "step": "partition", "actions": [] },
    { "step": "mdadm", "actions": [] },
    { "step": "persist", "actions": [] },
    { "step": "lvm", "actions": [] },
    { "step": "format", "fs": "btrfs" },
    { "step": "mount", "mountpoint": "/mnt/ryvie" }
  ]
}
```

## CreateRaidRequest
```json
{
  "type": "auto|raid1|raid5|shr-like",
  "diskIds": ["by-id-1", "by-id-2"],
  "label": "RYVIE",
  "mountpoint": "/mnt/ryvie",
  "force": false
}
```

## RaidStatus
```json
{
  "state": "creating|syncing|clean|degraded|error",
  "arrays": [
    { "name": "md0", "level": "raid1|raid5|...", "sizeBytes": 0, "progressPct": 0 }
  ],
  "mounted": false,
  "mountpoint": null,
  "fs": "btrfs",
  "messages": []
}
```

## API Endpoints (skeleton in Step 0)
- GET `/api/storage/disks`
- POST `/api/storage/proposal`
- POST `/api/storage/preflight`
- POST `/api/storage/raid/partition`
- POST `/api/storage/raid/mdadm`
- POST `/api/storage/raid/persist`
- POST `/api/storage/raid/lvm`
- POST `/api/storage/fs/format`
- POST `/api/storage/fs/mount`
- POST `/api/storage/btrfs/subvolumes`
- GET `/api/storage/raid/status`
- GET `/api/wizard/state` (optional)

All currently return HTTP 501 with:
```json
{ "ok": false, "error": "not_implemented", "endpoint": "..." }
```

## CLI Subcommands (skeleton)
- scan
- proposal
- preflight
- status
- create (pipeline)
- partition
- mdadm
- persist
- lvm
- format
- mount
- subvolumes

Each prints strict JSON to stdout:
```json
{
  "ok": false,
  "error": "not_implemented",
  "command": "scan",
  "args": { /* parsed from --json */ },
  "note": "Step 0 skeleton CLI. No disk operations are performed."
}
```
