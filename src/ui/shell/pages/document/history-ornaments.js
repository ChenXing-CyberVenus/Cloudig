// Chapter furniture, not identities or information-value symbols. Small
// illustrations share one pen, with no raster clipping or text in the art.
const drawings = {
  window: '<path d="M26 82V26Q60-6 94 26V82ZM26 46H94M60 10V82M18 84H102M20 89H100"/><path class="ornament-fill" d="M34 52H53V73H34ZM67 52H86V73H67Z"/><path d="M14 21l4 4m85-9-4 6M17 52l-6 1"/>',
  cloud: '<path d="M12 66C-1 46 25 31 36 44C37 16 78 12 86 40C108 26 132 56 110 67ZM22 76H98M34 85H88"/><path class="ornament-fill" d="m56 44 4-10 4 10 10 4-10 4-4 10-4-10-10-4Z"/>',
  net: '<path d="M15 25Q60 110 105 25M15 25Q60 82 105 25M22 39Q60 65 98 39M35 56L49 31M51 73L68 34M70 71L84 26M15 25L9 18M105 25L111 18"/><path d="M38 18Q34 6 48 8Q57-6 69 8Q85 7 80 19Z"/>',
  book: '<path d="M60 29Q39 16 15 27V79Q39 68 60 81Q81 68 105 79V27Q81 16 60 29ZM60 29V81M10 32H6V86Q35 74 60 88Q85 74 114 86V32H110M24 37Q39 32 49 38M24 49Q39 44 49 50M71 38Q87 32 96 37M71 50Q87 44 96 49"/><path class="ornament-fill" d="M79 23V54L86 47L92 53V22Z"/>',
  lamp: '<path d="M44 22Q60 9 76 22L88 43H32ZM60 43V76M43 83Q60 73 77 83M35 88H85M26 14l-6-7M94 14l6-7M16 40H5M104 40H115"/><path class="ornament-fill" d="M49 47H71L65 65H55Z"/>',
  pen: '<path d="M25 69L71 20Q91 1 103 8Q105 31 78 42L25 69ZM25 69L17 83M38 57L94 16M56 48L57 32M67 40L81 41M17 83H53M65 65H103M65 76H91M16 89H104"/>',
  star: '<path d="M10 63Q54 33 107 54M14 75Q61 47 108 65M22 85Q62 65 100 78"/><path class="ornament-fill" d="m62 9 6 18 19 5-19 5-6 18-6-18-19-5 19-5Z"/><circle cx="22" cy="34" r="2"/><circle cx="101" cy="20" r="2"/>',
  bridge: '<path d="M9 75Q60 48 111 75M9 86V75M111 86V75M26 84V69M46 80V63M74 80V63M94 84V69M9 38Q60 17 111 38M12 49Q60 28 108 49"/><path class="ornament-fill" d="M51 22a9 9 0 1 1 18 0Z"/>',
  bear: '<path d="M37 26Q24 6 16 25Q10 38 25 42M83 26Q97 6 105 25Q110 38 95 42M25 42Q21 17 60 20Q99 17 95 42Q103 72 60 76Q18 72 25 42ZM39 73Q25 101 58 99Q91 103 83 74"/><ellipse cx="60" cy="56" rx="17" ry="12"/><path d="M54 52H66L60 58ZM60 58V64M36 88L23 87M86 88L99 87"/><circle class="ornament-fill" cx="41" cy="43" r="3"/><circle class="ornament-fill" cx="79" cy="43" r="3"/>'
};
export function ornament(kind = 'cloud') {
  return `<svg class="history-ornament" viewBox="0 0 120 104" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${drawings[kind] ?? drawings.cloud}</svg>`;
}
export function chapterOrnament(volume, heading, index) {
  if (/空城|Empty City/u.test(heading)) return 'window';
  if (/结网|Netting/u.test(heading)) return 'net';
  if (/不写信|No More Letters/u.test(heading)) return 'pen';
  if (/序言|Preface/u.test(heading)) return 'bear';
  if (volume === 'future') return 'bridge';
  return ['book', 'lamp', 'cloud', 'star', 'pen', 'bridge'][index % 6];
}
