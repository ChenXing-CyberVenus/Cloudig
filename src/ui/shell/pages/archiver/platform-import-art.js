// Decorative, code-owned vectors. Copy, platform logos and hit targets stay in the DOM.
export const importDeskArt = `<svg class="archiver-json-desk" viewBox="0 0 320 164" aria-hidden="true" focusable="false">
  <ellipse cx="222" cy="148" rx="78" ry="9" fill="var(--desk-shadow)"/>
  <path d="M21 55C4 53 6 31 24 30C25 12 49 8 60 23C77 8 103 20 101 38C119 35 128 59 109 65H31" fill="var(--desk-cloud)"/>
  <path d="M18 58H108M35 72H77" fill="none" stroke="var(--desk-line)" stroke-width="2" stroke-linecap="round"/>
  <path d="M34 98C72 125 120 107 131 84C137 71 143 54 161 54" fill="none" stroke="var(--desk-trail)" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 7"/>
  <g transform="translate(74 72) rotate(-22)">
    <path d="M0 0H27L36 9V45H0Z" fill="var(--desk-paper)" stroke="var(--desk-line)" stroke-width="2" stroke-linejoin="round"/>
    <path d="M27 0V9H36M8 18H27M8 25H27M8 32H20" fill="none" stroke="var(--desk-trail)" stroke-width="2"/>
  </g>
  <path d="M159 82V68Q159 62 166 62H200L211 73H280Q287 73 287 80V139H159Z" fill="var(--desk-folder-back)" stroke="var(--desk-line)" stroke-width="2.5"/>
  <g transform="translate(191 35) rotate(9)">
    <path d="M0 0H49L61 12V89H0Z" fill="var(--desk-paper-back)" stroke="var(--desk-line)" stroke-width="2" stroke-linejoin="round"/>
    <path d="M49 0V12H61M12 28H44M12 37H47" fill="none" stroke="var(--desk-trail)" stroke-width="2"/>
  </g>
  <g transform="translate(172 53) rotate(-7)">
    <path d="M0 0H44L56 12V75H0Z" fill="var(--desk-paper)" stroke="var(--desk-line)" stroke-width="2" stroke-linejoin="round"/>
    <path d="M44 0V12H56" fill="var(--desk-paper-back)" stroke="var(--desk-line)" stroke-width="2"/>
    <path d="M12 23H40V38H24L17 43V38H12Z" fill="var(--desk-cloud)"/>
    <path d="M12 52H41M12 60H33" stroke="var(--desk-trail)" stroke-width="2"/>
  </g>
  <path d="M146 96Q144 88 153 88H195L208 99H295Q303 99 301 107L292 144H158Z" fill="var(--desk-folder)" stroke="var(--desk-line)" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M162 137H281" stroke="var(--desk-folder-edge)" stroke-width="2" stroke-linecap="round"/>
  <path d="M214 116H242V131H214Z" fill="var(--desk-label)"/>
  <path d="M220 123H236" stroke="var(--desk-line)" stroke-width="2" stroke-linecap="round"/>
  <path d="M142 21V33M136 27H148M282 39V51M276 45H288" stroke="var(--desk-spark)" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="124" cy="123" r="3" fill="var(--desk-spark)"/>
</svg>`;

export function importFileArt(zipped) {
  return `<svg class="archiver-json-file-art" viewBox="0 0 28 32" aria-hidden="true" focusable="false">${zipped
    ? '<path d="M3 7V3H20L25 8V28H3Z" fill="var(--import-fold)"/><path d="M2 10H12L15 13H26V29H2Z" fill="var(--import-paper)" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M15 14V24M13 16H17M13 20H17" stroke="currentColor" stroke-width="1.6"/><path d="M13 24H17V28H13Z" fill="currentColor"/>'
    : '<path d="M5 2H17L24 9V29H5Z" fill="var(--import-paper)" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M17 2V9H24" fill="var(--import-fold)" stroke="currentColor" stroke-width="1.6"/><path d="M10 15H19M10 19H19M10 23H16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'}</svg>`;
}
