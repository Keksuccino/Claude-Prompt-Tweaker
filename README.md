# Claude Prompt Tweaker

A mod for Claude Code, in the terminal and in the Code tab of the Claude desktop app. It shows you everything Claude Code sends the model besides your own messages, and lets you change it.

## What It Does

- **System Prompt:** read every section of Claude Code's system prompt, rewrite or drop any of them, add your own, and pick its full or short version.
- **Context:** change what gets added to the start of a conversation, like your CLAUDE.md files and the date, without touching the files.
- **Injected:** keep, rewrite or drop each kind of message Claude Code adds on its own while you work, like reminders and mode changes.
- **Tools:** rewrite a tool's description, or take the tool away from the model.
- **Desktop App:** read the instructions the desktop app adds. These can't be changed.
- **History:** see what was sent in each session, and edit it from there.

![image_1](/assets/image_1.png)
![image_2](/assets/image_2.png)
![image_3](/assets/image_3.png)

## How to Use It

Type `/tweaker`, or use the **Claude Tweaker** button above the message box. Open any item to replace its text, find and replace parts of it, or drop it. **Reset to Original** undoes your edit, and **Pause All Edits** turns all of them off until you resume them.

Edits to injected messages and removed tools apply from your next message on. Edits to the system prompt, context and tool descriptions apply to new conversations.

## Install

The easiest way: give Claude this repository's URL, `https://github.com/Keksuccino/Claude-Prompt-Tweaker`, and tell it to install this mod in Claude.

Or type this at the prompt of Claude Code in a terminal:

```
/plugin install prompt-tweaker --marketplace Keksuccino/Claude-Prompt-Tweaker
```

---

Copyright Keksuccino 2026. Licensed under [The Unlicense](LICENSE).
