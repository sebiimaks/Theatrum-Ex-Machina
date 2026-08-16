# Audited npm licence overrides

These files preserve exact-version copyright and MIT licence notices for
shipped npm packages whose published archive does not contain a standalone
licence file that the deterministic notice generator can consume.

Overrides are keyed to an exact package name and version in
`bin/generate-third-party-notices.mjs`. The build fails if an expected
override is absent, if a shipped dependency lacks licence text, or if an MIT
notice has no explicit copyright attribution. Package upgrades must be
reviewed against the upgraded package's own licence materials; an override is
never silently reused for another version.

| Package | Authoritative exact-version source | Reason for override |
| --- | --- | --- |
| `@iharbeck/ngx-virtual-scroller@19.0.1` | [v19.0.1 project source](https://github.com/iharbeck/ngx-virtual-scroller/tree/v19.0.1) | The npm archive places the full MIT notice in its README rather than a standalone licence file. |
| `an-qrcode@1.0.7` | [1.0.7 project source](https://github.com/naimmalek/an-qrcode/tree/1.0.7) | The npm archive declares MIT and carries the copyright notice in its README rather than a standalone licence file. |
| `assert-plus@1.0.0` | [v1.0.0 project source](https://github.com/TritonDataCenter/node-assert-plus/tree/v1.0.0) | The exact-version npm archive places its full MIT notice in the README rather than a standalone licence file. |
| `ignore@3.3.10` | [3.3.10 `LICENSE-MIT`](https://github.com/kaelzhang/node-ignore/blob/3.3.10/LICENSE-MIT) | The nested npm archive installed for this build omits upstream's standalone licence file. |
| `ip@2.0.1` | [v2.0.1 project source](https://github.com/indutny/node-ip/tree/v2.0.1) | The exact-version README contains the licence rather than a standalone licence file. |
| `slash@1.0.0` | [v1.0.0 `license`](https://github.com/sindresorhus/slash/blob/v1.0.0/license) | The nested npm archive installed for this build omits the exact-version licence file. |
