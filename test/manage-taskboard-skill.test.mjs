import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);

test("the taskboard skill coordinates safe issue execution and review handoff", () => {
  assert.match(skillSource, /run `issue get` and `comment list` before acting/i);
  assert.match(skillSource, /Treat comments as current requirements, including returned work/i);
  assert.match(skillSource, /read the issue again and move it to `in_progress` with its current `version`/i);
  assert.match(skillSource, /Stop if the status changed or the write conflicts/i);

  assert.match(
    skillSource,
    /Verify the requested operation path[\s\S]*Add a comment with the changes, verification result, outcome, and remaining risks[\s\S]*Read the issue again, then move it to `in_review` with its current `version`/i,
  );
});
