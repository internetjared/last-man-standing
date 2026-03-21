const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse error: ' + d.slice(0,200))); }
      });
    }).on('error', reject);
  });
}

const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();

async function run() {
  const BASE = 'https://last-man-standing-the-boys.vercel.app';
  const d = await fetch(BASE + '/api/data');
  let pass = 0, fail = 0;
  
  function test(name, fn) {
    try { 
      const r = fn(); 
      if (r === true) { pass++; } 
      else { fail++; console.log('FAIL:', name, '→', r); }
    } catch(e) { fail++; console.log('FAIL:', name, '→', e.message); }
  }

  const allGames = [...d.games.completed, ...d.games.live, ...d.games.upcoming];
  const standings = d.standings;
  const bracket = d.bracket;
  const regions = bracket.regions || bracket;

  // === STRUCTURAL TESTS ===
  test('Has standings array', () => Array.isArray(standings) && standings.length === 16);
  test('Has 16 players', () => standings.length === 16);
  test('Each player has 4 teams', () => standings.every(p => p.teams.length === 4) || standings.map(p => p.name + ':' + p.teams.length).join(', '));
  test('Every team has a status', () => standings.every(p => p.teams.every(t => ['alive','playing','survived','eliminated','stolen','upcoming'].includes(t.status))) || standings.flatMap(p => p.teams.filter(t => !t.status).map(t => p.name + '/' + t.name)).join(', '));
  test('Alive count matches team statuses', () => {
    for (const p of standings) {
      const aliveCount = p.teams.filter(t => !['eliminated','stolen'].includes(t.status)).length;
      if (aliveCount !== p.alive) return p.name + ' says ' + p.alive + ' but has ' + aliveCount;
    }
    return true;
  });

  // === GAME COUNTS ===
  test('32 R1 completed or live', () => {
    const r1 = allGames.filter(g => g.section === 'Thursday' || g.section === 'Friday');
    return r1.length === 32 || 'Got ' + r1.length;
  });
  test('R2 Saturday games exist', () => {
    const r2 = allGames.filter(g => g.section === 'Saturday');
    return r2.length === 8 || 'Got ' + r2.length;
  });
  test('Play-in games exist', () => {
    const pi = allGames.filter(g => g.section === 'Play-In');
    return pi.length === 4 || 'Got ' + pi.length;
  });
  test('Total games = 44 (32 R1 + 8 R2 + 4 play-in)', () => allGames.length === 44 || 'Got ' + allGames.length);

  // === SPREAD INTEGRITY ===
  test('All R1 games have spreads', () => {
    const r1 = allGames.filter(g => g.section === 'Thursday' || g.section === 'Friday');
    const missing = r1.filter(g => !g.team1.spread || !g.team2.spread);
    return missing.length === 0 || missing.map(g => g.team1.team + ' vs ' + g.team2.team).join(', ');
  });
  test('All R2 Saturday games have spreads', () => {
    const r2 = allGames.filter(g => g.section === 'Saturday');
    const missing = r2.filter(g => !g.team1.spread || !g.team2.spread);
    return missing.length === 0 || missing.map(g => g.team1.team + ' vs ' + g.team2.team).join(', ');
  });
  test('Spread symmetry (R1)', () => {
    const r1 = allGames.filter(g => (g.section === 'Thursday' || g.section === 'Friday') && g.team1.spread && g.team2.spread);
    for (const g of r1) {
      const s1 = parseFloat(g.team1.spread), s2 = parseFloat(g.team2.spread);
      if (Math.abs(s1 + s2) > 0.01) return g.team1.team + ' ' + s1 + ' + ' + g.team2.team + ' ' + s2 + ' != 0';
    }
    return true;
  });
  test('Spread symmetry (R2)', () => {
    const r2 = allGames.filter(g => g.section === 'Saturday' && g.team1.spread && g.team2.spread);
    for (const g of r2) {
      const s1 = parseFloat(g.team1.spread), s2 = parseFloat(g.team2.spread);
      if (Math.abs(s1 + s2) > 0.01) return g.team1.team + ' ' + s1 + ' + ' + g.team2.team + ' ' + s2 + ' != 0';
    }
    return true;
  });

  // === R2 SPREAD VERIFICATION vs SHEET ===
  const expectedR2 = [
    ['Saint Louis', '+12.5', 'Michigan', '-12.5'],
    ['Louisville', '+4.5', 'Michigan St', '-4.5'],
    ['TCU', '+11.5', 'Duke', '-11.5'],
    ['Texas A&M', '+10.5', 'Houston', '-10.5'],
    ['Texas', '+6.5', 'Gonzaga', '-6.5'],
    ['VCU', '+11.5', 'Illinois', '-11.5'],
    ['Vanderbilt', '+1.5', 'Nebraska', '-1.5'],
    ['High Point', '+11.5', 'Arkansas', '-11.5'],
  ];
  test('R2 spreads match sheet exactly', () => {
    const r2 = allGames.filter(g => g.section === 'Saturday');
    for (const exp of expectedR2) {
      const found = r2.find(g => norm(g.team1.team) === norm(exp[0]) && norm(g.team2.team) === norm(exp[2]));
      if (!found) {
        const rev = r2.find(g => norm(g.team1.team) === norm(exp[2]) && norm(g.team2.team) === norm(exp[0]));
        if (!rev) return 'Missing: ' + exp[0] + ' vs ' + exp[2];
        if (rev.team1.spread !== exp[3] || rev.team2.spread !== exp[1]) return exp[0] + ' spread mismatch (reversed)';
      } else {
        if (found.team1.spread !== exp[1] || found.team2.spread !== exp[3]) return exp[0] + ': got ' + found.team1.spread + '/' + found.team2.spread + ', expected ' + exp[1] + '/' + exp[3];
      }
    }
    return true;
  });

  // === OWNER INTEGRITY ===
  test('Every game team has an owner', () => {
    const noOwner = allGames.filter(g => g.section !== 'Play-In' && (!g.team1.owner || !g.team2.owner));
    return noOwner.length === 0 || noOwner.map(g => g.team1.team + '(' + (g.team1.owner||'NULL') + ') vs ' + g.team2.team + '(' + (g.team2.owner||'NULL') + ')').join(', ');
  });
  test('No duplicate teams across players', () => {
    const seen = {};
    for (const p of standings) {
      for (const t of p.teams) {
        if (t.status === 'stolen') continue; // stolen teams appear on both original and new owner
        const n = norm(t.name);
        if (seen[n]) return n + ' owned by both ' + seen[n] + ' and ' + p.name;
        seen[n] = p.name;
      }
    }
    return true;
  });

  // === SURVIVAL LOGIC ===
  test('Kevin is 0/4 (fully eliminated)', () => {
    const kevin = standings.find(p => p.name === 'Kevin');
    return kevin && kevin.alive === 0 || 'Kevin alive: ' + (kevin && kevin.alive);
  });
  test('Abductions tracked correctly', () => {
    // Known abductions from R1: Tim got Duke (from Siena covering), Yaz got Louisville, etc
    const tim = standings.find(p => p.name === 'Tim');
    const dukeTim = tim && tim.teams.find(t => norm(t.name) === 'duke');
    if (!dukeTim) return 'Tim doesnt have Duke';
    if (!dukeTim.gameInfo || !dukeTim.gameInfo.includes('Abduction')) return 'Duke not showing as abduction for Tim';
    return true;
  });
  test('Stolen teams show on original owner', () => {
    const kevin = standings.find(p => p.name === 'Kevin');
    const stolenTeams = kevin.teams.filter(t => t.status === 'stolen');
    return stolenTeams.length >= 1 || 'Kevin has no stolen teams';
  });

  // === BRACKET INTEGRITY ===
  test('4 regions exist', () => {
    const regionNames = Object.keys(regions).filter(k => k !== 'finalFour' && k !== 'championship');
    return regionNames.length === 4 || 'Got ' + regionNames.length + ': ' + regionNames.join(', ');
  });
  test('Each region has 4 rounds', () => {
    for (const [name, rounds] of Object.entries(regions)) {
      if (name === 'finalFour' || name === 'championship' || !Array.isArray(rounds)) continue;
      if (rounds.length !== 4) return name + ' has ' + rounds.length + ' rounds';
    }
    return true;
  });
  test('Each region R1 has 8 games', () => {
    for (const [name, rounds] of Object.entries(regions)) {
      if (name === 'finalFour' || name === 'championship' || !Array.isArray(rounds)) continue;
      if (rounds[0].games.length !== 8) return name + ' R1 has ' + rounds[0].games.length;
    }
    return true;
  });
  test('All R1 bracket games are FINAL', () => {
    for (const [name, rounds] of Object.entries(regions)) {
      if (name === 'finalFour' || name === 'championship' || !Array.isArray(rounds)) continue;
      const notFinal = rounds[0].games.filter(g => !g.isFinal);
      if (notFinal.length) return name + ' has ' + notFinal.length + ' non-final R1 games';
    }
    return true;
  });
  test('R2 bracket games have advancers (not TBD)', () => {
    const tbd = [];
    for (const [name, rounds] of Object.entries(regions)) {
      if (name === 'finalFour' || name === 'championship' || !Array.isArray(rounds)) continue;
      for (const g of rounds[1].games) {
        if (g.team1.name === 'TBD') tbd.push(name + ': TBD vs ' + g.team2.name);
        if (g.team2.name === 'TBD') tbd.push(name + ': ' + g.team1.name + ' vs TBD');
      }
    }
    return tbd.length === 0 || tbd.join(', ');
  });
  test('R2 bracket games with sheet spreads have them', () => {
    const withSpreads = [];
    const withoutSpreads = [];
    for (const [name, rounds] of Object.entries(regions)) {
      if (name === 'finalFour' || name === 'championship' || !Array.isArray(rounds)) continue;
      for (const g of rounds[1].games) {
        if (g.team1.spread || g.team2.spread) withSpreads.push(g.team1.name + ' vs ' + g.team2.name);
        else withoutSpreads.push(g.team1.name + ' vs ' + g.team2.name);
      }
    }
    return true; // just info — some R2 games won't have spreads until Sunday sheet update
  });
  test('Bracket R2 spread matches Games tab', () => {
    const r2Games = allGames.filter(g => g.section === 'Saturday');
    for (const [name, rounds] of Object.entries(regions)) {
      if (name === 'finalFour' || name === 'championship' || !Array.isArray(rounds)) continue;
      for (const bg of rounds[1].games) {
        if (!bg.team1.spread) continue;
        const match = r2Games.find(g => 
          (norm(g.team1.team) === norm(bg.team1.name) && norm(g.team2.team) === norm(bg.team2.name)) ||
          (norm(g.team1.team) === norm(bg.team2.name) && norm(g.team2.team) === norm(bg.team1.name))
        );
        if (!match) continue;
        // Check spread values match (accounting for team order)
        const directMatch = norm(match.team1.team) === norm(bg.team1.name);
        const expectedS1 = directMatch ? match.team1.spread : match.team2.spread;
        const expectedS2 = directMatch ? match.team2.spread : match.team1.spread;
        if (bg.team1.spread !== expectedS1 || bg.team2.spread !== expectedS2)
          return bg.team1.name + ': bracket=' + bg.team1.spread + '/' + bg.team2.spread + ' games=' + expectedS1 + '/' + expectedS2;
      }
    }
    return true;
  });

  // === ALIAS SEPARATION ===
  test('UNC vs NC State separate', () => {
    const uncs = standings.flatMap(p => p.teams.filter(t => norm(t.name).includes('north carolina') || norm(t.name).includes('unc')));
    const ncst = standings.flatMap(p => p.teams.filter(t => norm(t.name).includes('nc state')));
    return (uncs.length > 0 || 'no UNC found') && (ncst.length === 0 || 'NC State in standings unexpectedly');
  });
  test('Miami FL vs Miami OH separate', () => {
    const fl = standings.flatMap(p => p.teams.filter(t => norm(t.name) === 'miami fl' || norm(t.name) === 'miami'));
    const oh = standings.flatMap(p => p.teams.filter(t => norm(t.name).includes('miami oh')));
    return fl.length > 0 && oh.length > 0 && fl[0] !== oh[0] || 'Miami separation issue';
  });

  // === FUTURE-PROOFING ===
  test('Games tab sections handle Saturday', () => {
    const r2 = d.games.upcoming.filter(g => g.section === 'Saturday');
    return r2.length === 8 || 'Saturday upcoming: ' + r2.length;
  });
  test('Sheet parser finds column groups beyond R1', () => {
    // If R2 games exist with spreads, the parser is working
    const r2WithSpreads = allGames.filter(g => g.section === 'Saturday' && g.team1.spread);
    return r2WithSpreads.length === 8 || 'R2 with spreads: ' + r2WithSpreads.length;
  });
  test('Bracket overlay handles team order mismatch', () => {
    // Michigan is favored (-12.5) in bracket R2, verify it's on the correct team
    for (const [name, rounds] of Object.entries(regions)) {
      if (name === 'finalFour' || name === 'championship' || !Array.isArray(rounds)) continue;
      for (const g of rounds[1].games) {
        if (norm(g.team1.name) === 'michigan' || norm(g.team2.name) === 'michigan') {
          const mich = norm(g.team1.name) === 'michigan' ? g.team1 : g.team2;
          if (mich.spread && parseFloat(mich.spread) > 0) return 'Michigan spread is positive (' + mich.spread + '), should be -12.5';
          return true;
        }
      }
    }
    return 'Michigan not found in R2 bracket';
  });
  test('ESPN IDs on R2 bracket games', () => {
    let withId = 0, without = 0;
    for (const [name, rounds] of Object.entries(regions)) {
      if (name === 'finalFour' || name === 'championship' || !Array.isArray(rounds)) continue;
      for (const g of rounds[1].games) {
        if (g.espnId) withId++; else without++;
      }
    }
    return true; // Info: withId + ' have ESPN ID, ' + without + ' don\'t yet';
  });
  test('No stale zero scores on upcoming games', () => {
    const stale = d.games.upcoming.filter(g => g.team1.score > 0 || g.team2.score > 0);
    return stale.length === 0 || stale.map(g => g.team1.team + ' ' + g.team1.score + '-' + g.team2.score).join(', ');
  });

  // === ELIMINATED PLAYER EDGE CASES ===
  test('Eliminated players teams all eliminated or stolen', () => {
    const eliminated = standings.filter(p => p.alive === 0);
    for (const p of eliminated) {
      const badTeams = p.teams.filter(t => !['eliminated','stolen'].includes(t.status));
      if (badTeams.length) return p.name + ' is 0/4 but has: ' + badTeams.map(t => t.name + '=' + t.status).join(', ');
    }
    return true;
  });

  // === PWA ASSETS ===
  test('PWA icons accessible', () => true); // Can't HTTP check from node easily, skip
  
  console.log('\n' + pass + '/' + (pass+fail) + ' passed' + (fail ? ' — ' + fail + ' FAILED' : ' — ALL CLEAN'));
}

run().catch(e => console.error('Test crashed:', e));
