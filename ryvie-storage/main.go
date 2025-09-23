package main

import (
 "encoding/json"
 "flag"
 "fmt"
 "os"
 "os/exec"
 "path/filepath"
 "strings"
)

// Generic response envelope for non-implemented commands
type Response struct {
 Ok      bool                   `json:"ok"`
 Error   string                 `json:"error,omitempty"`
 Command string                 `json:"command"`
 Args    map[string]interface{} `json:"args,omitempty"`
 Note    string                 `json:"note,omitempty"`
}

// Step 1 structures
type Disk struct {
 ID         string      `json:"id"`
 Device     string      `json:"device"`
 SizeBytes  int64       `json:"sizeBytes"`
 SizeHuman  string      `json:"sizeHuman"`
 IsSystem   bool        `json:"isSystem"`
 IsMounted  bool        `json:"isMounted"`
 Mountpoint string      `json:"mountpoint,omitempty"`
 Health     string      `json:"health"`
 Partitions []Partition `json:"partitions"`
}

type Partition struct {
 Path      string `json:"path"`
 SizeBytes int64  `json:"sizeBytes"`
 FS        string `json:"fs,omitempty"`
 Type      string `json:"type,omitempty"`
}

type ScanResponse struct {
 Ok      bool                   `json:"ok"`
 Command string                 `json:"command"`
 Args    map[string]interface{} `json:"args,omitempty"`
 Note    string                 `json:"note,omitempty"`
 Disks   []Disk                 `json:"disks"`
}

func out(cmd string, args map[string]interface{}) {
 resp := Response{
  Ok:      false,
  Error:   "not_implemented",
  Command: cmd,
  Args:    args,
  Note:    "Step 0 skeleton CLI. No disk operations are performed.",
 }
 enc := json.NewEncoder(os.Stdout)
 enc.SetEscapeHTML(false)
 _ = enc.Encode(resp)
}

func printUsage() {
 fmt.Fprintln(os.Stderr, "ryvie-storage CLI (Step 1: scan read-only)\n")
 fmt.Fprintln(os.Stderr, "Usage:")
 fmt.Fprintln(os.Stderr, "  ryvie-storage <command> [--json args]\n")
 fmt.Fprintln(os.Stderr, "Commands:")
 fmt.Fprintln(os.Stderr, "  scan | proposal | preflight | status | create | partition | mdadm | persist | lvm | format | mount | subvolumes")
}

func main() {
 if len(os.Args) < 2 {
  printUsage()
  os.Exit(2)
 }

 cmd := os.Args[1]
 jsonArg := flag.NewFlagSet(cmd, flag.ContinueOnError)
 jsonStr := jsonArg.String("json", "{}", "JSON input body")
 _ = jsonArg.Parse(os.Args[2:])

 var args map[string]interface{}
 if err := json.Unmarshal([]byte(*jsonStr), &args); err != nil {
  // If JSON is invalid, still output strict JSON error
  out(cmd, map[string]interface{}{"parse_error": err.Error()})
  return
 }

 switch cmd {
 case "scan":
		scanDisks(args)
	case "proposal":
		proposal(args)
	case "preflight", "status", "create", "partition", "mdadm", "persist", "lvm", "format", "mount", "subvolumes":
		out(cmd, args)
 default:
  resp := Response{
   Ok:      false,
   Error:   "unknown_command",
   Command: cmd,
   Args:    args,
   Note:    "Unknown command",
  }
  enc := json.NewEncoder(os.Stdout)
  _ = enc.Encode(resp)
 }
}

// scanDisks performs a read-only scan using lsblk JSON and findmnt for root device.
func scanDisks(args map[string]interface{}) {
 // lsblk JSON for disks and partitions
 lsblkOut, err := exec.Command("lsblk", "-bJ", "-o", "NAME,KNAME,SIZE,TYPE,FSTYPE,MOUNTPOINT").Output()
 if err != nil {
  enc := json.NewEncoder(os.Stdout)
  _ = enc.Encode(map[string]any{
   "ok":      false,
   "command": "scan",
   "error":   "lsblk_failed",
   "detail":  err.Error(),
  })
  return
 }

 // root device
 rootSrcBytes, _ := exec.Command("findmnt", "-n", "-o", "SOURCE", "/").Output()
 rootSrc := strings.TrimSpace(string(rootSrcBytes))
 rootDisk := baseDiskFromSource(rootSrc)

 // Parse lsblk JSON
 var lsblk struct {
  Blockdevices []struct {
   Name       string `json:"name"`
   Kname      string `json:"kname"`
   Size       int64  `json:"size"`
   Type       string `json:"type"`
   Fstype     string `json:"fstype"`
   Mountpoint string `json:"mountpoint"`
   Children   []struct {
    Name       string `json:"name"`
    Kname      string `json:"kname"`
    Size       int64  `json:"size"`
    Type       string `json:"type"`
    Fstype     string `json:"fstype"`
    Mountpoint string `json:"mountpoint"`
   } `json:"children"`
  } `json:"blockdevices"`
 }
 if err := json.Unmarshal(lsblkOut, &lsblk); err != nil {
  enc := json.NewEncoder(os.Stdout)
  _ = enc.Encode(map[string]any{
   "ok":      false,
   "command": "scan",
   "error":   "parse_failed",
   "detail":  err.Error(),
  })
  return
 }

 var disks []Disk
 for _, bd := range lsblk.Blockdevices {
  if bd.Type != "disk" {
   continue
  }
  devPath := "/dev/" + bd.Name
  isSystem := (baseDiskFromSource(rootDisk) == devPath)

  // Partitions
  parts := make([]Partition, 0)
  isMounted := false
  mountpoint := ""
  for _, ch := range bd.Children {
   if ch.Type != "part" {
    continue
   }
   p := Partition{
    Path:      "/dev/" + ch.Name,
    SizeBytes: ch.Size,
    FS:        ch.Fstype,
    Type:      "partition",
   }
   parts = append(parts, p)
   if ch.Mountpoint != "" {
    isMounted = true
    if mountpoint == "" {
     mountpoint = ch.Mountpoint
    }
   }
  }

  disk := Disk{
   ID:         stableIdFromKname(bd.Kname),
   Device:     bd.Name,
   SizeBytes:  bd.Size,
   SizeHuman:  humanizeBytes(bd.Size),
   IsSystem:   isSystem,
   IsMounted:  isMounted || bd.Mountpoint != "",
   Mountpoint: mountpoint,
   Health:     "unknown",
   Partitions: parts,
  }
  disks = append(disks, disk)
 }

 enc := json.NewEncoder(os.Stdout)
 enc.SetEscapeHTML(false)
 _ = enc.Encode(ScanResponse{
  Ok:      true,
  Command: "scan",
  Args:    args,
  Note:    "Read-only disk inventory via lsblk",
  Disks:   disks,
 })
}

// baseDiskFromSource turns /dev/sda2 or /dev/nvme0n1p2 into /dev/sda or /dev/nvme0n1
func baseDiskFromSource(src string) string {
 if src == "" {
  return ""
 }
 base := filepath.Base(src)
 // nvme pattern: nvme0n1p2 -> nvme0n1
 if strings.HasPrefix(base, "nvme") {
  if i := strings.LastIndex(base, "p"); i > 0 {
   base = base[:i]
  }
 } else {
  // sdX, vdX, hdX -> trim trailing digit(s)
  for len(base) > 0 && base[len(base)-1] >= '0' && base[len(base)-1] <= '9' {
   base = base[:len(base)-1]
  }
 }
 return "/dev/" + base
}

// stableIdFromKname provides a stable-ish ID; Step 1 fallback to /dev/<kname>
func stableIdFromKname(kname string) string {
 if kname == "" {
  return ""
 }
 return "/dev/" + kname
}

func humanizeBytes(b int64) string {
 const unit = int64(1024)
 if b < unit {
  return fmt.Sprintf("%d B", b)
 }
 div, exp := unit, 0
 for n := b / unit; n >= unit; n /= unit {
  div *= unit
  exp++
 }
 return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

// --- Step 2: proposal ---
type ProposalResponse struct {
 Ok             bool                   `json:"ok"`
 Command        string                 `json:"command"`
 Args           map[string]interface{} `json:"args,omitempty"`
 Note           string                 `json:"note,omitempty"`
 SelectedDisks  []string               `json:"selectedDisks"`
 Suggested      string                 `json:"suggested"`
 CapacityBytes  int64                  `json:"capacityBytes"`
 FaultTolerance int                    `json:"faultTolerance"`
 PlanPreview    []map[string]any       `json:"planPreview"`
}

func proposal(args map[string]interface{}) {
 // Expect args: { "diskIds": ["/dev/sda", ...] }
 raw, ok := args["diskIds"]
 if !ok {
  enc := json.NewEncoder(os.Stdout)
  _ = enc.Encode(map[string]any{
   "ok": false, "command": "proposal", "error": "missing_diskIds",
  })
  return
 }

 // Normalize to []string
 var ids []string
 switch v := raw.(type) {
 case []any:
  for _, it := range v {
   if s, ok := it.(string); ok {
    ids = append(ids, s)
   }
  }
 case []string:
  ids = v
 default:
  enc := json.NewEncoder(os.Stdout)
  _ = enc.Encode(map[string]any{ "ok": false, "command": "proposal", "error": "invalid_diskIds" })
  return
 }

 if len(ids) < 2 {
  enc := json.NewEncoder(os.Stdout)
  _ = enc.Encode(map[string]any{ "ok": false, "command": "proposal", "error": "need_at_least_two_disks" })
  return
 }

 // Run scan to get sizes
 // This keeps Step 2 read-only and leverages existing scan code
 // Simpler: call lsblk again here to build a map of size by id/device
 lsblkOut, err := exec.Command("lsblk", "-bJ", "-o", "NAME,KNAME,SIZE,TYPE").Output()
 if err != nil {
  enc := json.NewEncoder(os.Stdout)
  _ = enc.Encode(map[string]any{ "ok": false, "command": "proposal", "error": "lsblk_failed", "detail": err.Error() })
  return
 }
 var ls struct { Blockdevices []struct{ Name, Kname, Type string; Size int64 } `json:"blockdevices"` }
 if err := json.Unmarshal(lsblkOut, &ls); err != nil {
  enc := json.NewEncoder(os.Stdout)
  _ = enc.Encode(map[string]any{ "ok": false, "command": "proposal", "error": "parse_failed", "detail": err.Error() })
  return
 }
 sizeByKey := map[string]int64{}
 for _, bd := range ls.Blockdevices {
  if bd.Type != "disk" { continue }
  sizeByKey["/dev/"+bd.Name] = bd.Size
  sizeByKey["/dev/"+bd.Kname] = bd.Size
 }

 var sizes []int64
 for _, id := range ids {
  if sz, ok := sizeByKey[id]; ok {
   sizes = append(sizes, sz)
  }
 }
 if len(sizes) != len(ids) {
  enc := json.NewEncoder(os.Stdout)
  _ = enc.Encode(map[string]any{ "ok": false, "command": "proposal", "error": "unknown_disks_in_selection" })
  return
 }

 // Heuristics
 suggested := "auto"
 capacity := int64(0)
 fault := 1
 n := len(sizes)
 // sort-like: derive min, max, sum
 var min, max, sum int64
 for i, s := range sizes {
  if i == 0 || s < min { min = s }
  if s > max { max = s }
  sum += s
 }
 roughlyEqual := (max-min) <= (min/20) // within ~5%

 if n == 2 {
  suggested = "raid1"
  capacity = min
  fault = 1
 } else if n >= 3 && roughlyEqual {
  suggested = "raid5"
  capacity = int64(n-1) * min
  fault = 1
 } else {
  suggested = "shr-like"
  // simple estimate: one-disk redundancy
  capacity = sum - max
  fault = 1
 }

 plan := []map[string]any{
  {"step": "partition", "actions": []any{}},
  {"step": "mdadm", "actions": []any{}},
  {"step": "persist", "actions": []any{}},
  {"step": "lvm", "actions": []any{}},
  {"step": "format", "fs": "btrfs"},
  {"step": "mount", "mountpoint": "/mnt/ryvie"},
 }

 enc := json.NewEncoder(os.Stdout)
 enc.SetEscapeHTML(false)
 _ = enc.Encode(ProposalResponse{
  Ok:             true,
  Command:        "proposal",
  Args:           args,
  Note:           "Dry-run plan suggestion. No changes performed.",
  SelectedDisks:  ids,
  Suggested:      suggested,
  CapacityBytes:  capacity,
  FaultTolerance: fault,
  PlanPreview:    plan,
 })
}
