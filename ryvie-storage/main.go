package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

type Response struct {
	Ok      bool                   `json:"ok"`
	Error   string                 `json:"error,omitempty"`
	Command string                 `json:"command"`
	Args    map[string]interface{} `json:"args,omitempty"`
	Note    string                 `json:"note,omitempty"`
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
	enc.Encode(resp)
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "ryvie-storage CLI (Step 0 skeleton)\n")
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
	case "scan", "proposal", "preflight", "status", "create", "partition", "mdadm", "persist", "lvm", "format", "mount", "subvolumes":
		out(cmd, args)
	default:
		out("unknown", map[string]interface{}{"requested": cmd})
	}
}
