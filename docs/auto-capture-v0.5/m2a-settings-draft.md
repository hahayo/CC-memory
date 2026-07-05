# M2a Claude Code Hooks Settings Draft

This is a draft only. Do not paste it until M2a is accepted and you want auto-capture enabled for the current Claude Code profile.

## Settings Snippet

Add the following hooks to `~/.claude/settings.json`, adjusting absolute paths if this repo moves:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/home/haha/CC_project/CC-memory/hooks/post-tool-use-capture.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/haha/CC_project/CC-memory/hooks/stop-capture-sentinel.sh"
          }
        ]
      }
    ]
  }
}
```

## Enable Conditions

- Use only after the M2a gate passes.
- Optional spool override for testing:

```bash
export CC_MEMORY_SPOOL_DIR=/tmp/cc-memory-spool
```

- Optional skip override:

```bash
export CC_MEMORY_SKIP_TOOLS='ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion'
```

An empty `CC_MEMORY_SKIP_TOOLS=''` means no tool is skipped.

## Rollback

Remove the `PostToolUse` and `Stop` entries above from `~/.claude/settings.json`.
