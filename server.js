const express = require('express');
const path = require('path');

const app = express();
const PORT = 3211;

// --- Data Sources ---
// Schedule sheet = single source of truth for matchups, spreads, owners
const SCHEDULE_CSV_URL = 'https://docs.google.com/spreadsheets/d/1uWC8_h_bMMe1Mfow6MuUsO_gSI5F8eCqFcbUNe5laXA/gviz/tq?tqx=out:csv&gid=1744774619';
// Main sheet for player rosters
const ROSTER_CSV_URL = 'https://docs.google.com/spreadsheets/d/1uWC8_h_bMMe1Mfow6MuUsO_gSI5F8eCqFcbUNe5laXA/gviz/tq?tqx=out:csv&gid=0';
// ESPN for scores only
const ESPN_SCOREBOARD = 'http://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';

// --- Cache ---
const cache = {};
const SHEET_TTL = 5 * 60 * 1000;
const ESPN_TTL = 15 * 1000;

async function getCached(key, fn, ttl) {
  const c = cache[key];
  if (c && (Date.now() - c.ts) < ttl) return c.data;
  try {
    const data = await fn();
    cache[key] = { data, ts: Date.now() };
    return data;
  } catch (err) {
    console.error(`Cache fetch error [${key}]:`, err.message);
    if (c) return c.data;
    throw err;
  }
}

// --- CSV Parser ---
function parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      lines.push(current); current = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      lines.push(current); current = ''; lines.push('\n');
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  const rows = []; let row = [];
  for (const item of lines) {
    if (item === '\n') { if (row.length > 0) rows.push(row); row = []; }
    else row.push(item.trim());
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

async function fetchCSV(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);
  return parseCSV(await res.text());
}

// --- ESPN ---
async function fetchESPN() {
  const allGames = [];
  const seen = new Set();
  // Scan full tournament window including play-in games
  const start = new Date('2026-03-17'); // Play-in games start 3/17
  const end = new Date(); end.setDate(end.getDate() + 2);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
    try {
      const res = await fetch(`${ESPN_SCOREBOARD}?groups=100&dates=${ds}`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const ev of (data.events || [])) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        const g = parseESPNEvent(ev);
        if (g) allGames.push(g);
      }
    } catch (e) { /* skip */ }
  }
  return allGames;
}

function parseESPNEvent(event) {
  const comp = event.competitions?.[0];
  if (!comp) return null;
  const teams = comp.competitors || [];
  const home = teams.find(t => t.homeAway === 'home');
  const away = teams.find(t => t.homeAway === 'away');
  const status = comp.status || event.status;
  const statusType = status?.type?.name || 'STATUS_SCHEDULED';
  const mkTeam = (t) => t ? {
    name: t.team?.location || t.team?.displayName || t.team?.name || '',
    shortName: t.team?.shortDisplayName || '',
    abbreviation: t.team?.abbreviation || '',
    score: parseInt(t.score || '0'),
    seed: t.curatedRank?.current || null,
  } : null;
  // Extract region from notes
  const notes = comp.notes || [];
  const headline = notes[0]?.headline || '';
  const regionMatch = headline.match(/(\w+)\s+Region/);
  const region = regionMatch ? regionMatch[1] : null;

  return {
    id: event.id, date: event.date,
    status: statusType,
    statusDetail: status?.type?.shortDetail || status?.type?.detail || '',
    home: mkTeam(home), away: mkTeam(away),
    isLive: statusType === 'STATUS_IN_PROGRESS' || statusType === 'STATUS_HALFTIME',
    isFinal: statusType === 'STATUS_FINAL',
    isScheduled: statusType === 'STATUS_SCHEDULED',
    region,
  };
}

// --- Team Matching ---
const ALIASES = {
  'north dakota st': ['north dakota state', 'ndsu', 'north dakota st bison'],
  "saint marys": ['saint marys', "st marys", "st. mary's", "saint mary's", 'saint marys gaels'],
  "st johns": ["st. john's", "saint john's", "saint johns", "st johns red storm"],
  'uconn': ['connecticut', 'connecticut huskies'],
  'miami fl': ['miami florida', 'miami hurricanes', 'miami (fl)', 'miami fl', 'miami'],
  'miami oh': ['miami ohio', 'miami redhawks', 'miami (oh)', 'miami oh redhawks', 'miami oh'],
  'ucf': ['central florida', 'ucf knights'],
  'vcu': ['virginia commonwealth', 'vcu rams'],
  'byu': ['brigham young', 'byu cougars'],
  'tcu': ['texas christian', 'tcu horned frogs'],
  'liu': ['long island', 'long island university', 'liu sharks'],
  'texas am': ['texas a&m', 'texas am aggies', 'texas a&m aggies'],
  'mcneese': ['mcneese state', 'mcneese cowboys'],
  'cal baptist': ['california baptist', 'cal baptist lancers', 'ca baptist'],
  'penn': ['pennsylvania', 'penn quakers'],
  'north carolina': ['unc', 'tar heels', 'north carolina tar heels'],
  'nc state': ['north carolina state', 'north carolina state wolfpack', 'nc state wolfpack'],
  'kennesaw st': ['kennesaw state', 'kennesaw state owls'],
  'wright st': ['wright state', 'wright state raiders'],
  'tennessee st': ['tennessee state', 'tennessee state tigers'],
  'south florida': ['usf', 'south florida bulls'],
  'northern iowa': ['uni', 'northern iowa panthers'],
  'saint louis': ['st. louis', 'st louis', 'saint louis billikens'],
  'queens nc': ['queens', 'queens royals', 'queens nc royals', 'queens university'],
  'iowa st': ['iowa state', 'iowa state cyclones'],
  'michigan st': ['michigan state', 'michigan state spartans'],
  'prairie view': ['prairie view a&m', 'prairie view am', 'prairie view a&m panthers'],
  'smu': ['southern methodist', 'smu mustangs'],
  'umbc': ['umbc retrievers'],
  'high point': ['high point panthers'],
  'hofstra': ['hofstra pride'],
  'utah st': ['utah state', 'utah state aggies'],
};

function norm(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Strict matching — no substring matching to avoid "north carolina" matching "north carolina state"
function teamsMatch(a, b) {
  if (!a || !b) return false;
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  // Check aliases — both names must resolve to the same canonical group
  const groupA = getAliasGroup(na);
  const groupB = getAliasGroup(nb);
  if (groupA && groupB && groupA === groupB) return true;
  if (groupA) {
    const allA = [norm(groupA), ...ALIASES[groupA].map(norm)];
    if (allA.includes(nb)) return true;
  }
  if (groupB) {
    const allB = [norm(groupB), ...ALIASES[groupB].map(norm)];
    if (allB.includes(na)) return true;
  }
  return false;
}

function getAliasGroup(normalized) {
  for (const [canon, alts] of Object.entries(ALIASES)) {
    const all = [norm(canon), ...alts.map(norm)];
    if (all.includes(normalized)) return canon;
  }
  return null;
}

// --- Parse Schedule Sheet → Games ---
// Each pair of rows = one matchup. Left cols (1-3) and right cols (5-7) are separate games.
// Format: seed | "TeamName (Owner)" | spread
// IMPORTANT: Spreads — the favorite has the spread, underdog's cell is empty.
// We need to derive the other side's spread (flip the sign).
function extractTeamAndOwner(display) {
  const m = display.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) return { team: m[1].trim(), owner: m[2].trim() };
  return { team: display.trim(), owner: null };
}

function parseScheduleSheet(rows) {
  if (!rows || rows.length === 0) return [];
  const games = [];
  let section = 'Thursday';

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    // Separator row
    if (row.some(c => c && /round|elite|championship/i.test(c))) {
      section = 'Friday';
      continue;
    }

    const row2 = rows[i + 1];
    if (!row2) continue;
    if (row2.some(c => c && /round|elite|championship/i.test(c))) continue;

    // Left game (cols 1-3): row[1]=seed, row[2]=team(owner), row[3]=spread
    const lt1 = (row[2] || '').trim();
    const lt2 = (row2[2] || '').trim();
    if (lt1 && lt2) {
      const t1 = extractTeamAndOwner(lt1);
      const t2 = extractTeamAndOwner(lt2);
      const s1raw = (row[3] || '').trim();
      const s2raw = (row2[3] || '').trim();
      // Derive missing spread from the other team
      const { spread1, spread2 } = deriveSpreads(s1raw, s2raw);
      games.push({
        section,
        team1: { ...t1, seed: (row[1] || '').trim(), spread: spread1 },
        team2: { ...t2, seed: (row2[1] || '').trim(), spread: spread2 },
      });
    }

    // Right game (cols 5-7)
    const rt1 = (row[6] || '').trim();
    const rt2 = (row2[6] || '').trim();
    if (rt1 && rt2) {
      const t1 = extractTeamAndOwner(rt1);
      const t2 = extractTeamAndOwner(rt2);
      const s1raw = (row[7] || '').trim();
      const s2raw = (row2[7] || '').trim();
      const { spread1, spread2 } = deriveSpreads(s1raw, s2raw);
      games.push({
        section,
        team1: { ...t1, seed: (row[5] || '').trim(), spread: spread1 },
        team2: { ...t2, seed: (row2[5] || '').trim(), spread: spread2 },
      });
    }

    i++; // consumed pair
  }
  return games;
}

// Given two spread cells from the sheet, derive both spreads.
// The sheet typically has the favorite's spread (negative) and the underdog's cell is blank or positive.
// If one is empty, compute it as the negation of the other.
function deriveSpreads(s1, s2) {
  const n1 = s1 ? parseFloat(s1) : null;
  const n2 = s2 ? parseFloat(s2) : null;

  if (n1 !== null && n2 !== null) {
    // Both present
    return { spread1: formatSpread(n1), spread2: formatSpread(n2) };
  }
  if (n1 !== null && n2 === null) {
    return { spread1: formatSpread(n1), spread2: formatSpread(-n1) };
  }
  if (n2 !== null && n1 === null) {
    return { spread1: formatSpread(-n2), spread2: formatSpread(n2) };
  }
  return { spread1: '', spread2: '' };
}

function formatSpread(n) {
  if (n === 0) return 'PK';
  return (n > 0 ? '+' : '') + n;
}

// --- Play-in games from ESPN (not on schedule sheet) ---
// Known play-in matchups
const PLAYIN_TEAMS = [
  ['Texas', 'NC State'],
  ['Howard', 'UMBC'],
  ['Miami (OH)', 'SMU'],
  ['Prairie View', 'Lehigh'],
];

function findPlayInGames(espnGames) {
  const playInGames = [];
  for (const [teamA, teamB] of PLAYIN_TEAMS) {
    for (const eg of (espnGames || [])) {
      if (!eg || !eg.home || !eg.away) continue;
      const hasA = teamsMatch(teamA, eg.home.name) || teamsMatch(teamA, eg.away.name);
      const hasB = teamsMatch(teamB, eg.home.name) || teamsMatch(teamB, eg.away.name);
      if (hasA && hasB) {
        // Build game card
        const t1isHome = teamsMatch(teamA, eg.home.name);
        playInGames.push({
          section: 'Play-In',
          team1: {
            team: teamA, owner: null, seed: '',
            spread: '', score: t1isHome ? eg.home.score : eg.away.score,
            won: eg.isFinal ? (t1isHome ? eg.home.score > eg.away.score : eg.away.score > eg.home.score) : null,
          },
          team2: {
            team: teamB, owner: null, seed: '',
            spread: '', score: t1isHome ? eg.away.score : eg.home.score,
            won: eg.isFinal ? (t1isHome ? eg.away.score > eg.home.score : eg.home.score > eg.away.score) : null,
          },
          espnStatus: eg.status,
          statusDetail: eg.statusDetail,
          isLive: eg.isLive,
          isFinal: eg.isFinal,
          date: eg.date,
          espnId: eg.id,
        });
        break;
      }
    }
  }
  return playInGames;
}

// --- Parse Roster Sheet → Player Picks ---
function parseRosterSheet(rows) {
  if (!rows || rows.length < 2) return {};
  const players = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[14]) continue;
    const name = row[14].trim();
    if (!name || name === '$') continue;
    const teams = [];
    for (const col of [15, 17, 19, 21]) {
      const cell = (row[col] || '').trim();
      if (cell) teams.push(cell);
    }
    if (teams.length > 0) players[name] = teams;
  }
  return players;
}

// --- Merge spreadsheet games with ESPN scores ---
function enrichGames(sheetGames, espnGames) {
  // Track which ESPN game IDs we've used for sheet games
  const usedEspnIds = new Set();

  const enriched = sheetGames.map(game => {
    let espn = null;
    for (const eg of (espnGames || [])) {
      if (!eg || !eg.home || !eg.away) continue;
      if (usedEspnIds.has(eg.id)) continue;
      const t1home = teamsMatch(game.team1.team, eg.home.name) || teamsMatch(game.team1.team, eg.home.shortName);
      const t1away = teamsMatch(game.team1.team, eg.away.name) || teamsMatch(game.team1.team, eg.away.shortName);
      const t2home = teamsMatch(game.team2.team, eg.home.name) || teamsMatch(game.team2.team, eg.home.shortName);
      const t2away = teamsMatch(game.team2.team, eg.away.name) || teamsMatch(game.team2.team, eg.away.shortName);
      if ((t1home && t2away) || (t1away && t2home)) {
        espn = eg;
        usedEspnIds.add(eg.id);
        const t1isHome = t1home;
        game.team1.score = t1isHome ? eg.home.score : eg.away.score;
        game.team2.score = t1isHome ? eg.away.score : eg.home.score;
        break;
      }
    }
    game.espnStatus = espn ? espn.status : 'STATUS_SCHEDULED';
    game.statusDetail = espn ? espn.statusDetail : '';
    game.isLive = espn ? espn.isLive : false;
    game.isFinal = espn ? espn.isFinal : false;
    game.date = espn ? espn.date : null;
    game.espnId = espn ? espn.id : null;
    game.region = espn ? espn.region : null;

    if (game.isFinal && game.team1.score != null && game.team2.score != null) {
      game.team1.won = game.team1.score > game.team2.score;
      game.team2.won = game.team2.score > game.team1.score;
      // Survival status
      const t1s = getSurvivalStatus(game.team1.score, game.team2.score, game.team1.spread);
      const t2s = getSurvivalStatus(game.team2.score, game.team1.score, game.team2.spread);
      game.team1.survived = t1s.survived;
      game.team1.survivalReason = t1s.reason;
      game.team2.survived = t2s.survived;
      game.team2.survivalReason = t2s.reason;
    }
    // Live spread tracking
    if (game.isLive && game.team1.score != null && game.team2.score != null) {
      const t1c = checkCover(game.team1.score, game.team2.score, game.team1.spread);
      const t2c = checkCover(game.team2.score, game.team1.score, game.team2.spread);
      game.team1.covering = t1c ? t1c.covered : null;
      game.team2.covering = t2c ? t2c.covered : null;
    }
    return game;
  });

  return enriched;
}

// --- Spread / Cover Logic ---
// Survival rules (same every round):
//   Win → survive
//   Lose but cover the spread → survive (abduction)
//   Lose and don't cover → ELIMINATED
// Cover check: team_score + spread > opponent_score (push = survives)
function checkCover(teamScore, oppScore, spreadStr) {
  if (teamScore == null || oppScore == null || !spreadStr) return null;
  const spread = parseFloat(spreadStr);
  if (isNaN(spread)) return null;
  const margin = teamScore - oppScore;
  const covered = margin + spread >= 0; // push = covers
  return { spread, margin, covered, won: teamScore > oppScore };
}

function getSurvivalStatus(teamScore, oppScore, spreadStr) {
  const check = checkCover(teamScore, oppScore, spreadStr);
  if (!check) {
    // No spread data (play-in games) — winners survive, losers eliminated
    if (teamScore != null && oppScore != null && teamScore > oppScore) return { survived: true, reason: 'Won' };
    return { survived: null, reason: '' };
  }
  if (check.won) {
    return { survived: true, reason: check.covered ? 'Won & covered' : 'Won (didn\'t cover)' };
  }
  // Lost
  if (check.covered) {
    return { survived: true, reason: 'Abduction — lost but covered' };
  }
  return { survived: false, reason: `Eliminated — lost & didn't cover` };
}

// --- Build Standings ---
function buildStandings(allGames, rosterPlayers) {
  const eliminated = new Map(); // norm(team) -> reason
  const playing = new Map(); // norm(team) -> { info, covering, margin }
  const survived = new Map(); // norm(team) -> reason (won or abduction)
  const abductions = new Map();
  
  // Build team→game lookup for spread/opponent/seed/time data
  const teamGameInfo = new Map(); // norm(team) -> { spread, opponent, seed, opponentSeed, time, section }
  // Build team→game lookup — first-round games take priority over play-in games
  // (play-ins lack spreads/seeds from the sheet and would clobber good data)
  for (const g of allGames) {
    const t1n = norm(g.team1.team), t2n = norm(g.team2.team);
    const t1data = { spread: g.team1.spread, opponent: g.team2.team, seed: g.team1.seed, opponentSeed: g.team2.seed, time: g.statusDetail, section: g.section, opponentOwner: g.team2.owner };
    const t2data = { spread: g.team2.spread, opponent: g.team1.team, seed: g.team2.seed, opponentSeed: g.team1.seed, time: g.statusDetail, section: g.section, opponentOwner: g.team1.owner };
    // Only set if no existing entry with spread data (prevents play-in from clobbering first-round)
    if (!teamGameInfo.has(t1n) || !teamGameInfo.get(t1n).spread) teamGameInfo.set(t1n, t1data);
    if (!teamGameInfo.has(t2n) || !teamGameInfo.get(t2n).spread) teamGameInfo.set(t2n, t2data);
    // Populate aliases
    for (const [mapKey] of [[t1n], [t2n]]) {
      const group = getAliasGroup(mapKey);
      if (group && ALIASES[group]) {
        const val = teamGameInfo.get(mapKey);
        ALIASES[group].forEach(a => { if (!teamGameInfo.has(norm(a)) || !teamGameInfo.get(norm(a)).spread) teamGameInfo.set(norm(a), val); });
        if (!teamGameInfo.has(norm(group)) || !teamGameInfo.get(norm(group)).spread) teamGameInfo.set(norm(group), val);
      }
    }
  }
  
  for (const g of allGames) {
    if (g.isFinal) {
      const t1status = getSurvivalStatus(g.team1.score, g.team2.score, g.team1.spread);
      const t2status = getSurvivalStatus(g.team2.score, g.team1.score, g.team2.spread);
      
      // Determine winner and loser
      const winner = g.team1.won ? g.team1 : g.team2.won ? g.team2 : null;
      const loser = g.team1.won ? g.team2 : g.team2.won ? g.team1 : null;
      const winnerStatus = g.team1.won ? t1status : t2status;
      const loserStatus = g.team1.won ? t2status : t1status;
      
      if (winner) {
        survived.set(norm(winner.team), winnerStatus.reason || 'Won');
      }
      
      if (loser) {
        if (loserStatus.survived === true) {
          // Abduction — loser covered the spread, inherits the winning team
          abductions.set(norm(loser.team), winner.team);
          survived.set(norm(loser.team), loserStatus.reason);
        } else if (loserStatus.survived === false) {
          eliminated.set(norm(loser.team), loserStatus.reason);
        } else {
          // No spread data (play-in games) — straight elimination
          eliminated.set(norm(loser.team), `Lost ${loser.score}-${winner.score}`);
        }
      }
    }
    if (g.isLive) {
      const t1live = checkCover(g.team1.score, g.team2.score, g.team1.spread);
      const t2live = checkCover(g.team2.score, g.team1.score, g.team2.spread);
      const t1tag = t1live ? (t1live.covered ? ' (covering)' : ' (not covering)') : '';
      const t2tag = t2live ? (t2live.covered ? ' (covering)' : ' (not covering)') : '';
      const spread1 = parseFloat(g.team1.spread) || 0;
      const spread2 = parseFloat(g.team2.spread) || 0;
      const scoreDiff1 = g.team1.score - g.team2.score; // positive = winning
      const margin1 = scoreDiff1 + spread1; // positive = covering
      const margin2 = -scoreDiff1 + spread2;
      playing.set(norm(g.team1.team), { info: `${g.team1.score}-${g.team2.score}${t1tag} ${g.statusDetail}`, covering: t1live ? t1live.covered : null, margin: margin1 });
      playing.set(norm(g.team2.team), { info: `${g.team2.score}-${g.team1.score}${t2tag} ${g.statusDetail}`, covering: t2live ? t2live.covered : null, margin: margin2 });
    }
  }

  const standings = Object.entries(rosterPlayers).map(([name, teams]) => {
    const teamDetails = teams.map(teamName => {
      // Handle play-in slash picks
      const slashMatch = teamName.match(/^(.+?)\s*\/\s*(.+)$/);
      if (slashMatch) {
        const [, optA, optB] = slashMatch;
        const aElim = isEliminated(optA.trim(), eliminated);
        const bElim = isEliminated(optB.trim(), eliminated);
        if (aElim && !bElim) {
          return resolveTeamStatus(optB.trim(), eliminated, playing, survived, abductions, null, teamGameInfo);
        }
        if (bElim && !aElim) {
          return resolveTeamStatus(optA.trim(), eliminated, playing, survived, abductions, null, teamGameInfo);
        }
        return { name: teamName, status: 'alive', gameInfo: 'Play-in pending' };
      }

      return resolveTeamStatus(teamName, eliminated, playing, survived, abductions, null, teamGameInfo);
    });

    const alive = teamDetails.filter(t => t.status !== 'eliminated').length;
    return { name, teams: teamDetails, alive };
  });

  standings.sort((a, b) => {
    if (b.alive !== a.alive) return b.alive - a.alive;
    return a.name.localeCompare(b.name);
  });

  return standings;
}

function isEliminated(teamName, eliminatedMap) {
  for (const [key] of eliminatedMap) {
    if (teamsMatch(teamName, key)) return true;
  }
  return false;
}

function resolveTeamStatus(teamName, eliminated, playing, survived, abductions, extraInfo, teamGameInfo) {
  // Look up game context for this team
  const gi = findTeamGameInfo(teamName, teamGameInfo);
  const gameCtx = gi ? { spread: gi.spread, opponent: gi.opponent, seed: gi.seed, opponentSeed: gi.opponentSeed, time: gi.time, section: gi.section, opponentOwner: gi.opponentOwner } : {};

  for (const [key, info] of eliminated) {
    if (teamsMatch(teamName, key)) {
      return { name: teamName, status: 'eliminated', gameInfo: info, ...gameCtx };
    }
  }
  for (const [key, data] of playing) {
    if (teamsMatch(teamName, key)) {
      return { name: teamName, status: 'playing', gameInfo: data.info, covering: data.covering, margin: data.margin, ...gameCtx };
    }
  }
  for (const [key, info] of survived) {
    if (teamsMatch(teamName, key)) {
      const abductedTo = abductions ? abductions.get(key) : null;
      const displayName = abductedTo || teamName;
      const gameInfo = abductedTo
        ? `${info} → now riding ${abductedTo}`
        : (extraInfo ? `${extraInfo} · ${info}` : info);
      return { name: displayName, status: 'alive', gameInfo, abductedFrom: abductedTo ? teamName : null, ...gameCtx };
    }
  }
  return { name: teamName, status: 'alive', gameInfo: extraInfo, ...gameCtx };
}

function findTeamGameInfo(teamName, teamGameInfo) {
  if (!teamGameInfo) return null;
  const n = norm(teamName);
  if (teamGameInfo.has(n)) return teamGameInfo.get(n);
  for (const [key, val] of teamGameInfo) {
    if (teamsMatch(teamName, key)) return val;
  }
  return null;
}

// --- Bracket Builder ---
function buildBracketData(games, rosterPlayers) {
  function makeGame(g) {
    return {
      team1: { name: g.team1.team, seed: g.team1.seed, owner: g.team1.owner, score: g.team1.score, spread: g.team1.spread, won: g.team1.won, survived: g.team1.survived, survivalReason: g.team1.survivalReason },
      team2: { name: g.team2.team, seed: g.team2.seed, owner: g.team2.owner, score: g.team2.score, spread: g.team2.spread, won: g.team2.won, survived: g.team2.survived, survivalReason: g.team2.survivalReason },
      isFinal: g.isFinal, isLive: g.isLive, statusDetail: g.statusDetail || '', region: g.region
    };
  }

  function getAdvancer(game) {
    if (!game || !game.isFinal) return null;
    const winner = game.team1.won ? game.team1 : game.team2.won ? game.team2 : null;
    const loser = game.team1.won ? game.team2 : game.team2.won ? game.team1 : null;
    if (!winner) return null;
    // Abduction: if the loser survived (covered the spread), the LOSER inherits the winning TEAM
    // The loser's owner now rides the winning team forward
    let owner = winner.owner;
    let abducted = false;
    if (loser && loser.survived === true) {
      // Loser covered — loser's owner takes the winning team
      owner = loser.owner;
      abducted = true;
    }
    return { name: winner.name, seed: winner.seed, owner, abducted };
  }

  function buildRegionRounds(r1games) {
    // Sort by seed matchup: 1v16, 8v9, 5v12, 4v13, 6v11, 3v14, 7v10, 2v15
    const seedOrder = [1,8,5,4,6,3,7,2];
    r1games.sort((a, b) => {
      const aTop = Math.min(parseInt(a.team1.seed)||99, parseInt(a.team2.seed)||99);
      const bTop = Math.min(parseInt(b.team1.seed)||99, parseInt(b.team2.seed)||99);
      return seedOrder.indexOf(aTop) - seedOrder.indexOf(bTop);
    });

    const rounds = [{ name: '1st Round', games: r1games }];
    const roundNames = ['2nd Round', 'Sweet 16', 'Elite 8'];
    let prev = r1games;

    for (const rName of roundNames) {
      if (prev.length < 2) break;
      const next = [];
      for (let i = 0; i < prev.length; i += 2) {
        const adv1 = getAdvancer(prev[i]);
        const adv2 = prev[i + 1] ? getAdvancer(prev[i + 1]) : null;
        next.push({
          team1: adv1 || { name: 'TBD', seed: '', owner: null },
          team2: adv2 || { name: 'TBD', seed: '', owner: null },
          isFinal: false, isLive: false, statusDetail: ''
        });
      }
      rounds.push({ name: rName, games: next });
      prev = next;
    }
    return rounds;
  }

  // Group R1 games by region
  const regionGames = { East: [], West: [], South: [], Midwest: [] };
  for (const g of games) {
    const bg = makeGame(g);
    const r = bg.region || 'Unknown';
    if (regionGames[r]) regionGames[r].push(bg);
    else regionGames[r] = [bg];
  }

  const regions = {};
  for (const [regionName, rGames] of Object.entries(regionGames)) {
    if (rGames.length > 0) {
      regions[regionName] = buildRegionRounds(rGames);
    }
  }

  // Final Four + Championship from region winners
  const finalFourTeams = [];
  for (const regionName of ['East', 'West', 'South', 'Midwest']) {
    const rounds = regions[regionName];
    if (!rounds) { finalFourTeams.push(null); continue; }
    const elite8 = rounds[rounds.length - 1];
    if (elite8 && elite8.games.length === 1) {
      finalFourTeams.push(getAdvancer(elite8.games[0]));
    } else {
      finalFourTeams.push(null);
    }
  }

  const ff1 = {
    team1: finalFourTeams[0] || { name: 'TBD', seed: '', owner: null },
    team2: finalFourTeams[1] || { name: 'TBD', seed: '', owner: null },
    isFinal: false, isLive: false, statusDetail: '', label: 'East vs West'
  };
  const ff2 = {
    team1: finalFourTeams[2] || { name: 'TBD', seed: '', owner: null },
    team2: finalFourTeams[3] || { name: 'TBD', seed: '', owner: null },
    isFinal: false, isLive: false, statusDetail: '', label: 'South vs Midwest'
  };

  const ffWinner1 = getAdvancer(ff1);
  const ffWinner2 = getAdvancer(ff2);
  const championship = {
    team1: ffWinner1 || { name: 'TBD', seed: '', owner: null },
    team2: ffWinner2 || { name: 'TBD', seed: '', owner: null },
    isFinal: false, isLive: false, statusDetail: ''
  };

  return { regions, finalFour: [ff1, ff2], championship };
}

// --- API ---
const fs = require('fs');
const publicDir = path.join(__dirname, 'public');

// Explicit static file routes (Vercel serverless doesn't serve express.static for binary files)
app.get('/icon-192.png', (req, res) => {
  res.type('image/png').send(fs.readFileSync(path.join(publicDir, 'icon-192.png')));
});
app.get('/icon-512.png', (req, res) => {
  res.type('image/png').send(fs.readFileSync(path.join(publicDir, 'icon-512.png')));
});

app.use(express.static(publicDir));

app.get('/api/data', async (req, res) => {
  try {
    const [scheduleRows, rosterRows, espnGames] = await Promise.all([
      getCached('schedule', () => fetchCSV(SCHEDULE_CSV_URL), SHEET_TTL),
      getCached('roster', () => fetchCSV(ROSTER_CSV_URL), SHEET_TTL),
      getCached('espn', fetchESPN, ESPN_TTL),
    ]);

    // Parse sheet games and enrich with ESPN scores
    const sheetGames = parseScheduleSheet(scheduleRows);
    const games = enrichGames(sheetGames, espnGames);
    
    // Get play-in games from ESPN (not on sheet)
    const playInGames = findPlayInGames(espnGames);
    
    // All games combined for standings
    const allGames = [...games, ...playInGames];
    
    // Roster from main sheet
    const rosterPlayers = parseRosterSheet(rosterRows);

    // Backfill missing owners from roster (play-in winners on sheet lack owner tags)
    const teamToOwner = {};
    for (const [player, teams] of Object.entries(rosterPlayers)) {
      for (const t of teams) {
        // Handle slash picks like "Prairie View / Lehigh"
        const slashMatch = t.match(/^(.+?)\s*\/\s*(.+)$/);
        const teamNames = slashMatch ? [slashMatch[1].trim(), slashMatch[2].trim()] : [t];
        for (const tn of teamNames) {
          teamToOwner[norm(tn)] = player;
          const group = getAliasGroup(norm(tn));
          if (group && ALIASES[group]) {
            teamToOwner[norm(group)] = player;
            ALIASES[group].forEach(a => { teamToOwner[norm(a)] = player; });
          }
        }
      }
    }
    for (const g of allGames) {
      if (!g.team1.owner && g.team1.team) {
        const n = norm(g.team1.team);
        const group = getAliasGroup(n);
        g.team1.owner = teamToOwner[n] || (group ? teamToOwner[norm(group)] : null) || null;
      }
      if (!g.team2.owner && g.team2.team) {
        const n = norm(g.team2.team);
        const group = getAliasGroup(n);
        g.team2.owner = teamToOwner[n] || (group ? teamToOwner[norm(group)] : null) || null;
      }
    }

    const standings = buildStandings(allGames, rosterPlayers);

    // Bracket
    const bracket = buildBracketData(games, rosterPlayers);

    // Sort games: live first, then upcoming by section, then completed (play-ins first, then others)
    const live = games.filter(g => g.isLive);
    const upcoming = games.filter(g => !g.isLive && !g.isFinal).sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : Infinity;
      const db = b.date ? new Date(b.date).getTime() : Infinity;
      return da - db;
    });
    const completed = [
      ...games.filter(g => g.isFinal),
      ...playInGames.filter(g => g.isFinal),
    ];
    const livePlayIn = playInGames.filter(g => g.isLive);

    res.json({
      standings,
      games: { live: [...livePlayIn, ...live], upcoming, completed },
      bracket,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Local dev: listen on PORT. Vercel: export the app.
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`Last Man Standing running on http://localhost:${PORT}`);
  });
}
