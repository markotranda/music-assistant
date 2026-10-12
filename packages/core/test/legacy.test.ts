import { describe, expect, it } from "vitest";
import {
  csvRows,
  mapLegacyStatus,
  matchFiles,
  normFromFileName,
  parseBandsCsv,
  parsePlanCsv,
  quotaChecksum,
  recoverText,
} from "../src/legacy";

// Fixtures are literal rows from the legacy PowerShell tool's real state files
// (tools/state/bands.csv, tools/state/plan.csv) — the migration's golden input.
const BANDS_CSV = `"Band","Score","MBID","StudioAlbums","Catalog","Quota","Disambig"
"3 Inches of Blood","1","ba85753c-671a-409e-b813-1e3be41e2a2e","5","69","5",""
"AC+DC","3","66c662b6-6e2f-4930-8610-912e24c63ed1","19","174","26","Australian hard rock band"
"Accept","2","41f4d85a-0bd7-4602-a3e3-8c47f36efb0a","17","166","15","German heavy metal band"`;

const PLAN_CSV = `"Band","Score","Rank","Title","Norm","Status","Source","Ext","Pinned"
"The Rolling Stones","2","1","Paint It, Black","paintitblack","DOWNLOAD","","","False"
"The Rolling Stones","2","2","Gimme Shelter","gimmeshelter","OWNED","Z:\\media\\music\\The Rolling Stones\\Let It Bleed (1969)\\The Rolling Stones - Let It Bleed - 01 - Gimme Shelter.mp3",".mp3","False"
"The Rolling Stones","2","3","Sympathy for the Devil","sympathyforthedevil","OWNED","Z:\\media\\music\\The Rolling Stones\\Beggars Banquet (1968)\\The Rolling Stones - Beggars Banquet - 01 - Sympathy for the Devil.m4a",".m4a","False"
"The Rolling Stones","2","4","Gimme Shelter (live)","gimmeshelter","PLANNED","","","True"`;

describe("csvRows", () => {
  it("parses quoted fields with commas, CRLF, and doubled quotes", () => {
    const rows = csvRows('a,"b, c",d\r\n"say ""hi""",e,f\n');
    expect(rows).toEqual([
      ["a", "b, c", "d"],
      ['say "hi"', "e", "f"],
    ]);
  });
});

describe("recoverText", () => {
  it("repairs UTF-8-through-latin1 mojibake from the legacy writer", () => {
    // Real legacy corruption: "singer—songwriter" written as UTF-8 bytes read
    // back through latin-1.
    expect(recoverText("singer\u00e2\u0080\u0090songwriter")).toBe("singer\u2010songwriter");
  });

  it("leaves clean text alone", () => {
    expect(recoverText("Australian hard rock band")).toBe("Australian hard rock band");
    expect(recoverText("Mot\u00f6rhead")).toBe("Mot\u00f6rhead");
  });
});

describe("parseBandsCsv", () => {
  it("parses real legacy band rows and flags nothing", () => {
    const { rows, problems } = parseBandsCsv(BANDS_CSV);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      band: "3 Inches of Blood",
      score: 1,
      mbid: "ba85753c-671a-409e-b813-1e3be41e2a2e",
      studioAlbums: 5,
      catalog: 69,
      legacyQuota: 5,
      disambig: null,
    });
    expect(rows[1].disambig).toBe("Australian hard rock band");
  });

  it("reports unparsable rows instead of guessing, skips blank records", () => {
    const { rows, problems } = parseBandsCsv(
      '"Band","Score","MBID","StudioAlbums","Catalog","Quota","Disambig"\n"","","","","","",""\n"Good Band","9","","","","",""',
    );
    expect(rows).toHaveLength(0);
    // The all-empty record reads as a blank line (skipped); the bad score is flagged.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unparsed bands.csv row");
  });
});

describe("quotaChecksum", () => {
  it("recomputes real legacy quotas with the pinned formula and matches every row", () => {
    const { rows } = parseBandsCsv(BANDS_CSV);
    const checks = quotaChecksum(rows);
    expect(checks).toHaveLength(3);
    // Live parity against the legacy tool's own Quota column.
    expect(checks.map((c) => [c.band, c.computedQuota, c.ok])).toEqual([
      ["3 Inches of Blood", 5, true],
      ["AC+DC", 26, true],
      ["Accept", 15, true],
    ]);
  });

  it("flags a mismatch instead of hiding it", () => {
    const { rows } = parseBandsCsv(
      '"Band","Score","MBID","StudioAlbums","Catalog","Quota","Disambig"\n"X","1","","","69","4",""',
    );
    const [check] = quotaChecksum(rows);
    expect(check).toMatchObject({ band: "X", legacyQuota: 4, computedQuota: 5, ok: false });
  });
});

describe("parsePlanCsv", () => {
  it("parses real legacy plan rows, keeps Norm verbatim, ignores Source/Ext", () => {
    const { rows, problems } = parsePlanCsv(PLAN_CSV);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      band: "The Rolling Stones",
      score: 2,
      rank: 1,
      title: "Paint It, Black",
      norm: "paintitblack",
      status: "DOWNLOAD",
      pinned: false,
    });
    expect(rows[3]).toMatchObject({ norm: "gimmeshelter", status: "PLANNED", pinned: true });
  });

  it("reports unparsable rows instead of guessing", () => {
    const { problems } = parsePlanCsv(
      '"Band","Score","Rank","Title","Norm","Status","Source","Ext","Pinned"\n"X","2","0","","","OWNED","","","False"',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unparsed plan.csv row");
  });
});

describe("mapLegacyStatus", () => {
  it("reality wins: stale legacy statuses never override the disk", () => {
    expect(mapLegacyStatus("OWNED", true)).toBe("OWNED");
    expect(mapLegacyStatus("OWNED", false)).toBe("PLANNED"); // stale
    expect(mapLegacyStatus("DOWNLOAD", true)).toBe("OWNED"); // file appeared
    expect(mapLegacyStatus("PLANNED", false)).toBe("PLANNED");
  });
});

describe("normFromFileName", () => {
  it("reproduces the legacy Norm column from on-disk names", () => {
    expect(normFromFileName("01 - Gimme Shelter.mp3")).toBe("gimmeshelter");
    expect(normFromFileName("01 - Paint It, Black.m4a")).toBe("paintitblack");
    expect(normFromFileName("02 - Sympathy for the Devil.mp3")).toBe("sympathyforthedevil");
  });
});

describe("matchFiles", () => {
  it("matches by norm title and reports both kinds of leftovers", () => {
    const { rows } = parsePlanCsv(PLAN_CSV);
    const result = matchFiles(rows, [
      { fileName: "01 - Paint It, Black.mp3" },
      { fileName: "02 - Gimme Shelter.mp3" },
      { fileName: "02 - Gimme Shelter (live).flac" },
      { fileName: "Some Off-Plan Song.mp3" },
    ]);

    // Both gimme shelter rows match (studio + live) — same norm, distinct rows.
    expect(result.matched.map((m) => [m.norm, m.fileName])).toEqual([
      ["paintitblack", "01 - Paint It, Black.mp3"],
      ["gimmeshelter", "02 - Gimme Shelter.mp3"],
      ["gimmeshelter", "02 - Gimme Shelter (live).flac"],
    ]);
    expect(result.unmatchedRows.map((r) => r.rank)).toEqual([3]); // no file
    expect(result.unmatchedFiles).toEqual(["Some Off-Plan Song.mp3"]);
  });

  it("never assigns one file to two rows", () => {
    const result = matchFiles(
      [
        { norm: "a", rank: 1 },
        { norm: "a", rank: 2 },
      ],
      [{ fileName: "01 - A.mp3" }],
    );
    expect(result.matched).toHaveLength(1);
    expect(result.unmatchedRows).toHaveLength(1);
  });
});
