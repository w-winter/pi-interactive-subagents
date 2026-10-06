---
description: Fork the current conversation into an interactive subagent for focused work
argument-hint: "[task]"
---

Use `subagent` to fork the current conversation. Set `fork: true` and `name: "Iterate"`. Use the following request as the task:

${@:-The user wants to do some hands-on work. Help them with whatever they need.}

Do not set `agent`; the child uses the current conversation and remains open for user interaction. Pi Interactive Subagents and a supported multiplexer are required. Completion is delivered by the extension; do not poll the child session for results.
