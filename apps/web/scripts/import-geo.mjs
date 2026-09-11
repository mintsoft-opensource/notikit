#!/usr/bin/env node
/**
 * 위치 데이터 적재 — 국가 목록 + IP→국가 구간.
 *
 *   node scripts/import-geo.mjs --dry-run        # 받아서 검증만, DB 미변경
 *   node scripts/import-geo.mjs                  # 국가 + IPv4 + IPv6
 *   node scripts/import-geo.mjs --no-ipv6        # IPv6 생략(약 21MB·행 절약)
 *   node scripts/import-geo.mjs --countries-only # 국가 목록만 갱신
 *
 * 출처
 *   국가 코드/지역 : mledoze/countries (정적 데이터셋)
 *   국가 이름      : Node 의 ICU (Intl.DisplayNames) — 번역 출처를 늘리지 않는다
 *   IP→국가       : DB-IP Lite via sapics/ip-location-db, CC BY 4.0
 *                   https://db-ip.com/ — 표기 의무가 있어 화면·문서에 출처를 남긴다
 *
 * GeoLite2 는 쓰지 않는다. 정확도는 낫지만 MaxMind EULA 라 셀프호스팅 배포판에
 * 데이터를 함께 넣을 수 없다.
 *
 * 멱등하다. 국가는 upsert, IP 구간은 패밀리 단위로 교체한다.
 */
import postgres from "postgres";

const COUNTRY_SOURCE = "https://raw.githubusercontent.com/mledoze/countries/master/dist/countries.json";
const IP_SOURCE = (v) =>
  `https://raw.githubusercontent.com/sapics/ip-location-db/main/dbip-country/dbip-country-ipv${v}.csv`;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noIpv6 = args.includes("--no-ipv6");
const countriesOnly = args.includes("--countries-only");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function get(url, label) {
  console.log(`· 내려받는 중: ${label}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`${label} 다운로드 실패 (HTTP ${res.status})`);
  return res;
}

async function loadCountries() {
  const raw = await (await get(COUNTRY_SOURCE, "국가 데이터셋")).json();
  if (!Array.isArray(raw)) fail("국가 데이터 형식이 예상과 다릅니다 — 최상위가 배열이 아닙니다");

  const ko = new Intl.DisplayNames(["ko"], { type: "region" });
  const rows = [];
  let skipped = 0;

  for (const c of raw) {
    const code = typeof c?.cca2 === "string" ? c.cca2.toUpperCase() : null;
    const nameEn = c?.name?.common;
    // 코드나 이름이 없으면 표기에 쓸 수 없다 — 조용히 넘기지 않고 센다
    if (!code || code.length !== 2 || typeof nameEn !== "string") {
      skipped++;
      continue;
    }
    rows.push({
      code,
      // ICU 에 없는 코드는 영문명으로 메운다(notNull 이라 비울 수 없다)
      name_ko: ko.of(code) || nameEn,
      name_en: nameEn,
      region: c.region || null,
    });
  }
  return { rows, skipped };
}

/** `시작IP,끝IP,국가코드` CSV → 행. 형식이 어긋난 줄은 세어서 보고한다. */
function parseIpCsv(text, family) {
  const rows = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [start, end, cc] = line.split(",");
    if (!start || !end || !cc || cc.trim().length !== 2) {
      bad++;
      continue;
    }
    rows.push({ start_ip: start.trim(), end_ip: end.trim(), family, country_code: cc.trim().toUpperCase() });
  }
  return { rows, bad };
}

async function loadIpRanges(family) {
  const text = await (await get(IP_SOURCE(family), `IP→국가 IPv${family} (DB-IP Lite)`)).text();
  const { rows, bad } = parseIpCsv(text, family);
  console.log(`  · IPv${family} 구간 ${rows.length.toLocaleString()}건` + (bad ? `, 형식 불일치 ${bad}건` : ""));
  if (rows.length < 1000) fail(`IPv${family} 구간이 비정상적으로 적습니다 (${rows.length}) — 원본이 손상됐을 수 있어 중단합니다`);
  return rows;
}

/** 한 번에 다 넣으면 파라미터 한도를 넘긴다. 청크로 나눠 넣는다. */
async function insertChunked(tx, rows, size = 2000) {
  for (let i = 0; i < rows.length; i += size) {
    await tx`insert into ip_country_ranges ${tx(rows.slice(i, i + size))}`;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url && !dryRun) fail("DATABASE_URL 이 필요합니다 (검증만 하려면 --dry-run)");

  const { rows: countries, skipped } = await loadCountries();
  console.log(`· 국가 ${countries.length}건` + (skipped ? `, 건너뜀 ${skipped}건` : ""));
  if (countries.length < 200) fail(`국가 수가 비정상적으로 적습니다 (${countries.length})`);
  console.log(`· 표본 KR → ${countries.find((c) => c.code === "KR")?.name_ko ?? "?"}`);

  const families = countriesOnly ? [] : noIpv6 ? [4] : [4, 6];
  const ipRanges = {};
  for (const f of families) ipRanges[f] = await loadIpRanges(f);

  if (dryRun) {
    console.log("· --dry-run — DB 를 건드리지 않고 종료합니다");
    return;
  }

  const sql = postgres(url, { max: 1 });
  // 이력 행을 먼저 남긴다. 적재 도중 죽어도 "시작했는데 안 끝났다"가 보여야 한다.
  const [run] = await sql`
    insert into geo_imports (status, countries, ipv4, ipv6)
    values ('running', ${countries.length}, ${ipRanges[4]?.length ?? 0}, ${ipRanges[6]?.length ?? 0})
    returning id
  `;

  try {
    await sql.begin(async (tx) => {
      for (const c of countries) {
        await tx`
          insert into countries ${tx(c)}
          on conflict (code) do update set
            name_ko = excluded.name_ko,
            name_en = excluded.name_en,
            region = excluded.region,
            updated_at = now()
        `;
      }

      // IP 구간은 upsert 가 아니라 교체다. 원본에서 사라진 구간이 남아 있으면
      // 옛 소유 국가로 잘못 판정하므로, 해당 패밀리를 통째로 갈아끼운다.
      for (const f of families) {
        await tx`delete from ip_country_ranges where family = ${f}`;
        await insertChunked(tx, ipRanges[f]);
        console.log(`  ✓ IPv${f} ${ipRanges[f].length.toLocaleString()}건 적재`);
      }
    });
    await sql`update geo_imports set status = 'ok', finished_at = now() where id = ${run.id}`;
    console.log("✓ 적재 완료");
  } catch (e) {
    // 실패를 조용히 넘기면 낡은 데이터로 계속 판정하게 된다 — 이력에 남긴다.
    const msg = e?.message ?? String(e);
    await sql`update geo_imports set status = 'failed', finished_at = now(), error = ${msg} where id = ${run.id}`;
    throw e;
  } finally {
    await sql.end();
  }
}

main().catch((e) => fail(e?.message ?? String(e)));
