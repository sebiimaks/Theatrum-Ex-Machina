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
| `assert-plus@1.0.0` | [v1.0.0 project source](https://github.com/TritonDataCenter/node-assert-plus/tree/v1.0.0) | The exact-version npm archive places its full MIT notice in the README rather than a standalone licence file. |
