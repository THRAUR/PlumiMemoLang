/* pixel.js — tiny pixel-art renderer (no deps, CSP-safe).
   <span class="px" data-art="flame" data-cell="2"></span>
   Chars map to colours. 'k' is currentColor, so an icon inherits the text
   colour of wherever it sits (a nav link, a button, the accent chip). The
   bird's own plumage is fixed hex, so Plumi looks the same on paper and on
   phosphor. Susan-Kare-flavoured, kept simple. */
(function () {
  var PAL = {
    k: 'currentColor',
    a: 'var(--accent)',
    g: 'var(--green)',
    w: 'var(--bg)',
    m: 'var(--faint)',
    // Plumi's fixed plumage
    e: '#2A1A10',   // outline, eye
    h: '#F6EFE3',   // cream body
    l: '#F2C98A',   // peach belly / cheek
    t: '#E0915E',   // terracotta beak + feet (the accent, but fixed so the bird never recolours)
    d: '#C7BFAE'    // wing shade
  };

  var ART = {
    /* ---------- Plumi, 16x16. Four moods share one silhouette. ---------- */
    'bird-idle': [
      '.......e........',
      '......ee........',
      '.....eeeeee.....',
      '....ehhhhhhe....',
      '...ehhhhhhhhe...',
      '...eheehhheehe..',
      '...ehhhhhhhhe...',
      '...ehhhtthhhe...',
      '..eehhhhhhhhee..',
      '.edhhhhllllhhhde',
      '.edhhhhllllhhhde',
      '..eehhhllllhhee.',
      '...ehhhhhhhhe...',
      '....eeeeeeee....',
      '......t..t......',
      '.....tt..tt.....'
    ],
    'bird-blink': [
      '.......e........',
      '......ee........',
      '.....eeeeee.....',
      '....ehhhhhhe....',
      '...ehhhhhhhhe...',
      '...ehhhhhhhhe...',
      '...eheehhheehe..',
      '...ehhhtthhhe...',
      '..eehhhhhhhhee..',
      '.edhhhhllllhhhde',
      '.edhhhhllllhhhde',
      '..eehhhllllhhee.',
      '...ehhhhhhhhe...',
      '....eeeeeeee....',
      '......t..t......',
      '.....tt..tt.....'
    ],
    'bird-happy': [
      '.......e........',
      '......ee........',
      '.....eeeeee.....',
      '....ehhhhhhe....',
      '...ehhhhhhhhe...',
      '.e.eheehhheehe.e',
      '.eeehhhhhhhheeee',
      '..edhhhtthhhde..',
      '...ehhhhhhhhe...',
      '...ehhhllllhhe..',
      '...ehhhllllhhe..',
      '...ehhhllllhhe..',
      '...ehhhhhhhhe...',
      '....eeeeeeee....',
      '......t..t......',
      '.....tt..tt.....'
    ],
    'bird-think': [
      '.......e........',
      '......ee........',
      '.....eeeeee.....',
      '....ehhhhhhe....',
      '...ehhehhhehe...',
      '...ehhhhhhhhe...',
      '...ehhhhhhhhe...',
      '...ehhhtthhhe...',
      '..eehhhhhhhhee..',
      '.edhhhhllllhhhde',
      '.edhhhhllllhhhde',
      '..eehhhllllhhee.',
      '...ehhhhhhhhe...',
      '....eeeeeeee....',
      '......t..t......',
      '.....tt..tt.....'
    ],
    'bird-sad': [
      '.......e........',
      '......ee........',
      '.....eeeeee.....',
      '....ehhhhhhe....',
      '...ehhhhhhhhe...',
      '...ehhhhhhhhe...',
      '...eheehhheehe..',
      '...ehhhhhhhhe...',
      '..eehhhtthhhee..',
      '.edhhhhllllhhhde',
      '.edhhhhllllhhhde',
      '.edhhhhllllhhhde',
      '..eehhhhhhhhee..',
      '....eeeeeeee....',
      '......t..t......',
      '.....tt..tt.....'
    ],
    'bird-sleep': [
      '.......e........',
      '......ee........',
      '.....eeeeee.....',
      '....ehhhhhhe....',
      '...ehhhhhhhhe...',
      '...eheeehheeee..',
      '...ehhhhhhhhe...',
      '...ehhhtthhhe...',
      '..eehhhhhhhhee..',
      '.edhhhhllllhhhde',
      '.edhhhhllllhhhde',
      '..eehhhllllhhee.',
      '...ehhhhhhhhe...',
      '....eeeeeeee....',
      '......t..t......',
      '.....tt..tt.....'
    ],

    /* ---------- 12x12 icons, 'k' = currentColor ---------- */
    today: [
      '............',
      '..k......k..',
      '.kkkkkkkkkk.',
      '.k........k.',
      '.kkkkkkkkkk.',
      '.k........k.',
      '.k.kk.kk..k.',
      '.k........k.',
      '.k.kk.kk..k.',
      '.k........k.',
      '.kkkkkkkkkk.',
      '............'
    ],
    lessons: [
      '............',
      '..kkk.......',
      '..kkk.......',
      '....k.......',
      '....kkkk....',
      '.......k....',
      '.....kkkkk..',
      '.....kkkkk..',
      '.......k....',
      '....kkkk....',
      '....k.......',
      '..kkk.......'
    ],
    review: [
      '............',
      '....kkkkkkk.',
      '....k.....k.',
      '.kkkkkkk..k.',
      '.k.....k..k.',
      '.k.....k..k.',
      '.k..k..k..k.',
      '.k.....k..k.',
      '.k.....kkkk.',
      '.k.....k....',
      '.kkkkkkk....',
      '............'
    ],
    words: [
      '............',
      '.....kk.....',
      '.kkkkkkkkkk.',
      '.k........k.',
      '............',
      '..kkkkkkkk..',
      '.......k....',
      '......k.....',
      '.kkkkkkkkkk.',
      '.....k......',
      '.....k......',
      '....kk......'
    ],
    notes: [
      '............',
      '.........kk.',
      '........kkkk',
      '.......kkkk.',
      '......kkkk..',
      '.....kkkk...',
      '....kkkk....',
      '...kkkk.....',
      '..kkkk......',
      '..kk........',
      '..k.........',
      '............'
    ],
    settings: [
      '............',
      '.....kk.....',
      '..k.kkkk.k..',
      '..kkkkkkkk..',
      '...kk..kk...',
      '.kkk....kkk.',
      '.kkk....kkk.',
      '...kk..kk...',
      '..kkkkkkkk..',
      '..k.kkkk.k..',
      '.....kk.....',
      '............'
    ],
    flame: [
      '............',
      '......k.....',
      '.....kk.....',
      '.....kkk....',
      '....kkkk..k.',
      '...kkkkkk.k.',
      '...kkkkkkkk.',
      '..kkkkwwkkk.',
      '..kkkwwwwkk.',
      '..kkkkwwkkk.',
      '...kkkkkkk..',
      '....kkkkk...'
    ],
    bolt: [
      '............',
      '......kk....',
      '.....kk.....',
      '....kk......',
      '...kkkkkk...',
      '......kk....',
      '.....kk.....',
      '....kk......',
      '...kk.......',
      '..kk........',
      '.k..........',
      '............'
    ],
    check: [
      '............',
      '............',
      '..........k.',
      '.........kk.',
      '........kk..',
      '.......kk...',
      '.k....kk....',
      '.kk..kk.....',
      '..kkkk......',
      '...kk.......',
      '............',
      '............'
    ],
    x: [
      '............',
      '.k........k.',
      '.kk......kk.',
      '..kk....kk..',
      '...kk..kk...',
      '....kkkk....',
      '....kkkk....',
      '...kk..kk...',
      '..kk....kk..',
      '.kk......kk.',
      '.k........k.',
      '............'
    ],
    plus: [
      '............',
      '............',
      '.....kk.....',
      '.....kk.....',
      '.....kk.....',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '.....kk.....',
      '.....kk.....',
      '.....kk.....',
      '............',
      '............'
    ],
    speaker: [
      '............',
      '.....k......',
      '....kk...k..',
      '...kkk..k.k.',
      '.kkkkk.k..k.',
      '.kkkkk.k.k.k',
      '.kkkkk.k.k.k',
      '.kkkkk.k..k.',
      '...kkk..k.k.',
      '....kk...k..',
      '.....k......',
      '............'
    ],
    star: [
      '............',
      '.....kk.....',
      '.....kk.....',
      '....kkkk....',
      '.kkkkkkkkkk.',
      '..kkkkkkkk..',
      '...kkkkkk...',
      '...kkkkkk...',
      '..kkk..kkk..',
      '..kk....kk..',
      '............',
      '............'
    ],
    bulb: [
      '............',
      '....kkkk....',
      '...k....k...',
      '..k......k..',
      '..k......k..',
      '..k......k..',
      '...k....k...',
      '....k..k....',
      '....kkkk....',
      '....k..k....',
      '....kkkk....',
      '............'
    ],
    trophy: [
      '............',
      '.kkkkkkkkkk.',
      'k.k......k.k',
      'k.k......k.k',
      '.kk......kk.',
      '..k......k..',
      '...k....k...',
      '....kkkk....',
      '.....kk.....',
      '.....kk.....',
      '...kkkkkk...',
      '............'
    ],
    clock: [
      '............',
      '....kkkk....',
      '..kk....kk..',
      '.k........k.',
      '.k....k...k.',
      'k.....k....k',
      'k.....kkk..k',
      '.k........k.',
      '.k........k.',
      '..kk....kk..',
      '....kkkk....',
      '............'
    ],
    search: [
      '............',
      '...kkkk.....',
      '..k....k....',
      '.k......k...',
      '.k......k...',
      '.k......k...',
      '..k....k....',
      '...kkkkkk...',
      '........kk..',
      '.........kk.',
      '..........kk',
      '............'
    ],
    arrow: [
      '............',
      '............',
      '.......k....',
      '.......kk...',
      '.......kkk..',
      '.kkkkkkkkkk.',
      '.kkkkkkkkkk.',
      '.......kkk..',
      '.......kk...',
      '.......k....',
      '............',
      '............'
    ],
    back: [
      '............',
      '............',
      '....k.......',
      '...kk.......',
      '..kkk.......',
      '.kkkkkkkkkk.',
      '.kkkkkkkkkk.',
      '..kkk.......',
      '...kk.......',
      '....k.......',
      '............',
      '............'
    ],
    camera: [
      '............',
      '....kkk.....',
      '.kkkkkkkkkk.',
      '.k........k.',
      '.k..kkkk..k.',
      '.k.k....k.k.',
      '.k.k....k.k.',
      '.k..kkkk..k.',
      '.k........k.',
      '.kkkkkkkkkk.',
      '............',
      '............'
    ],
    sun: [
      '............',
      '.....k......',
      '.k...k...k..',
      '..k.kkk.k...',
      '...kkkkk....',
      'kkkkkkkkkkk.',
      '...kkkkk....',
      '..k.kkk.k...',
      '.k...k...k..',
      '.....k......',
      '............',
      '............'
    ],
    moon: [
      '............',
      '....kkkk....',
      '...kk.......',
      '..kk........',
      '..kk........',
      '..kk........',
      '..kk........',
      '..kk........',
      '...kk.......',
      '....kkkk....',
      '............',
      '............'
    ],
    refresh: [
      '............',
      '....kkkk..k.',
      '..kk....kkk.',
      '.k......kkk.',
      '.k..........',
      '.k..........',
      '..........k.',
      '..........k.',
      '.kkk......k.',
      '.kkkk....kk.',
      '.k..kkkk....',
      '............'
    ],
    trash: [
      '............',
      '....kkkk....',
      '.kkkkkkkkkk.',
      '..k......k..',
      '..k.k.k..k..',
      '..k.k.k..k..',
      '..k.k.k..k..',
      '..k.k.k..k..',
      '..k......k..',
      '..kkkkkkkk..',
      '............',
      '............'
    ],
    heart: [
      '............',
      '..kk....kk..',
      '.kkkk..kkkk.',
      'kkkkkkkkkkkk',
      'kkkkkkkkkkkk',
      'kkkkkkkkkkkk',
      '.kkkkkkkkkk.',
      '..kkkkkkkk..',
      '...kkkkkk...',
      '....kkkk....',
      '.....kk.....',
      '............'
    ],
    mic: [
      '............',
      '....kkkk....',
      '....kkkk....',
      '....kkkk....',
      '....kkkk....',
      '..k.kkkk.k..',
      '..k.kkkk.k..',
      '..kk....kk..',
      '...kkkkkk...',
      '.....kk.....',
      '....kkkk....',
      '............'
    ],
    play: [
      '............',
      '...k........',
      '...kk.......',
      '...kkk......',
      '...kkkk.....',
      '...kkkkk....',
      '...kkkkk....',
      '...kkkk.....',
      '...kkk......',
      '...kk.......',
      '...k........',
      '............'
    ],
    stop: [
      '............',
      '............',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '............',
      '............'
    ],
    doc: [
      '............',
      '..kkkkkk....',
      '..k....kk...',
      '..k....k.k..',
      '..k....kkkk.',
      '..k.kkk...k.',
      '..k.......k.',
      '..k.kkkkk.k.',
      '..k.......k.',
      '..k.kkkkk.k.',
      '..kkkkkkkkk.',
      '............'
    ],
    minus: [
      '............',
      '............',
      '............',
      '............',
      '............',
      '..kkkkkkkk..',
      '..kkkkkkkk..',
      '............',
      '............',
      '............',
      '............',
      '............'
    ],
    up: [
      '............',
      '.....kk.....',
      '....kkkk....',
      '...kkkkkk...',
      '..kkkkkkkk..',
      '.....kk.....',
      '.....kk.....',
      '.....kk.....',
      '.....kk.....',
      '.....kk.....',
      '............',
      '............'
    ],
    down: [
      '............',
      '............',
      '.....kk.....',
      '.....kk.....',
      '.....kk.....',
      '.....kk.....',
      '.....kk.....',
      '..kkkkkkkk..',
      '...kkkkkk...',
      '....kkkk....',
      '.....kk.....',
      '............'
    ],
    dots: [
      '............',
      '............',
      '............',
      '............',
      '............',
      '.kk..kk..kk.',
      '.kk..kk..kk.',
      '............',
      '............',
      '............',
      '............',
      '............'
    ]
  };

  function render(el) {
    var name = el.getAttribute('data-art');
    var art = ART[name];
    if (!art || el.childElementCount) return el;
    var cell = parseInt(el.getAttribute('data-cell') || '2', 10);
    var cols = art[0].length;
    el.style.gridTemplateColumns = 'repeat(' + cols + ',' + cell + 'px)';
    el.style.gridAutoRows = cell + 'px';
    el.setAttribute('role', 'img');
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-hidden')) el.setAttribute('aria-hidden', 'true');
    var frag = document.createDocumentFragment();
    for (var y = 0; y < art.length; y++) {
      var rowStr = art[y];
      for (var x = 0; x < cols; x++) {
        var ch = rowStr[x];
        var cellEl = document.createElement('i');
        if (ch && ch !== '.') cellEl.style.background = PAL[ch] || ch;
        frag.appendChild(cellEl);
      }
    }
    el.appendChild(frag);
    return el;
  }

  function pixel(name, cell) {
    var s = document.createElement('span');
    s.className = 'px';
    s.setAttribute('data-art', name);
    s.setAttribute('data-cell', String(cell || 2));
    return render(s);
  }

  function boot() {
    var nodes = document.querySelectorAll('.px[data-art]');
    for (var i = 0; i < nodes.length; i++) render(nodes[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.PlumiPixel = { render: render, pixel: pixel, ART: ART, PAL: PAL };
})();
