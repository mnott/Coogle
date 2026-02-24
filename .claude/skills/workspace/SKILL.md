---
name: Workspace
description: Google Workspace preferences and defaults for Gmail, Calendar, Drive, Docs, and Sheets via workspace MCP. USE WHEN user mentions gmail, email, calendar, drive, docs, sheets, google workspace, archive mail, schedule event, OR any workspace MCP operation.
---

# Workspace - Google Workspace Preferences

**User-specific defaults and conventions for all Google Workspace MCP operations.**

## General

- **Always** use `mnott@mnott.de` as `user_google_email` for all workspace API calls
- All workspace tools are prefixed `mcp__coogle__` (routed through Coogle daemon)
- **Multi-account access**: Gina (gina@mnott.de) and Amelie (amelie@mnott.de) are OAuth-authorized — can create contacts and events on their accounts directly

## Gmail

### Archiving (MANDATORY)

When archiving emails, **always do both**:

1. **Remove** the `INBOX` label
2. **Add** the `[Imap]/Archive` label (ID: `Label_4`)

This ensures archived mail appears in the user's IMAP Archive folder across all mail clients.

```
remove_label_ids: ["INBOX"]
add_label_ids: ["Label_4"]
```

For multiple emails, use `batch_modify_gmail_message_labels`.

### Label Reference

| Label | ID | Usage |
|-------|----|-------|
| `[Imap]/Archive` | `Label_4` | **Primary archive** (always use this) |
| `Archivieren` | `Label_3` | Alternative archive (only if user requests) |
| `Notes` | `Label_2` | Notes label |

## Calendar

### Calendar IDs

| Calendar ID | Person | Relation | Access | Timezone |
|-------------|--------|----------|--------|----------|
| `mnott@mnott.de` | Matthias Nott | Primary (self) | Owner | Europe/Zurich |
| `gina@mnott.de` | Grazyna Nott | Wife | Write | Europe/Zurich |
| `amelie@mnott.de` | Amelie Rose Nott | Daughter | Write | Pacific/Auckland |

### Calendar Conventions

- When creating events for Gina, use timezone `Europe/Zurich`
- When creating events for Amelie, use timezone `Pacific/Auckland`
- When user says "Monday" etc., calculate the correct date (don't assume)
- The US holidays calendar (`de.usa#holiday@group.v.calendar.google.com`) is also subscribed
- **Newlines in descriptions**: Use actual newlines in the string, NOT `\n` escape sequences. The API passes them literally otherwise.
- **Reminders**: Default to 60 minutes (1 hour) before, not the Google default of 10 minutes. Use `use_default_reminders: false` with `reminders: [{"method": "popup", "minutes": 60}]`
- **modify_event requires start_time + end_time**: Even when only changing other fields, always include the original start/end times or the API will error.

## Examples

**Example 1: Archive an email**
```
User: "Archive that email"
-> modify_gmail_message_labels with remove INBOX + add Label_4
-> Confirm to user
```

**Example 2: Check a family member's calendar**
```
User: "What does Gina have next week?"
-> get_events with calendar_id=gina@mnott.de, correct date range
-> Present events with times in CET
```

**Example 3: Create event on family calendar**
```
User: "Add a dentist appointment for Amelie on Friday at 2pm"
-> create_event with calendar_id=amelie@mnott.de, timezone=Pacific/Auckland
-> Confirm event created
```
