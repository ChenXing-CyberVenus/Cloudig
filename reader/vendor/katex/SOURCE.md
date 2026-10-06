# KaTeX static-layout vendor source

- Package: `katex@0.18.0`
- Registry tarball: `https://registry.npmjs.org/katex/-/katex-0.18.0.tgz`
- Tarball SHA-256: `2a5a53549279a644f5c5333965e550a8403875fc42b38dc65f2a6f94586e99f9`
- License: MIT, preserved verbatim in `LICENSE.txt`
- Added by: GPT-5.6-Sol·奥思·万卷同辉 Osis.MyriadScrollsShineTogether

These files were copied from the official npm package, not from the protected
Cloudig bookmarklet sources. The twelve WOFF2 files are also byte-identical to
the corresponding fonts already embedded in the twelve authorized final HTML
samples. This provides an independent source-to-package identity check.

`katex-static-0.18.0.min.css` keeps the official KaTeX 0.18.0 layout rules.
Its `@font-face` prelude is deliberately reduced to the twelve WOFF2 faces
observed in the authorized final samples, and each face has one local
`./fonts/*.woff2` source. It has no network URL, WOFF fallback, or TTF fallback.

The files in this directory are build inputs. A standalone `reader.html` must
inline the CSS and replace every local font URL with the corresponding WOFF2
data URL. Shipping the relative URLs unchanged inside a standalone HTML file
would not satisfy Cloudig's offline contract.

## WOFF2 inventory

```text
0cdd387c9590a1a9f9794560022dbb59654a7d86f187aa0c81495ad42d3a7308  KaTeX_AMS-Regular.woff2
74444efd593c005e3f4573b44524704c0af0a937fe911cca9e94068d0d140d3f  KaTeX_Fraktur-Bold.woff2
51814d270d06ff0255dba0799994fa4d8c84d11f09951d47595f4abb1f3602dc  KaTeX_Fraktur-Regular.woff2
0f60d1b897938ec918c8ce073092411baf9438f6739465693ff18b0f9d20b021  KaTeX_Main-Bold.woff2
c2342cd8b869e01752a9321dc17213fc40d4d04c79688c1d43f2cf316abd7866  KaTeX_Main-Regular.woff2
dc47344dbb6cb5b655c8460d561f4df5f501b90c804ad3c6cec65fe322351ab1  KaTeX_Math-BoldItalic.woff2
7af58c5ec8f132a2ddde9027c6d7814decce4d3b822a11192a42a20e2e973264  KaTeX_Math-Italic.woff2
6b47c40166b6dbe21a5dfca7718413f2147fd2399be1ba605d8ad39cedf25dfe  KaTeX_Size1-Regular.woff2
d04c54219f9eaec6d4d4fd42dfb28785975a4794d6b2fc71e566b9cd6db842dd  KaTeX_Size2-Regular.woff2
73d591271b1604960cb10bb90fee021670af7297017e0e98480b332d11f51995  KaTeX_Size3-Regular.woff2
a4af7d414440a1c1790825cfb700cf9cf43b0f2c4b04f0ebc523011ad9853ec0  KaTeX_Size4-Regular.woff2
71d517d67827787cfabdf186914cc3358eda539e37931941f2b2fd4a21f68c0b  KaTeX_Typewriter-Regular.woff2
```
