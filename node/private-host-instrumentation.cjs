/* Test-only compiler for the native actual-main acceptance fixture. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const WORKSPACE = '/Users/sm/Workspace';
const DRIVER = '__privateHostAcceptance';

function inside(root, value) {
  const relative = path.relative(root, value);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function canonical(value, root, directory) {
  assert.ok(typeof value === 'string' && path.isAbsolute(value) && inside(root, value), 'Acceptance paths must remain inside their owned root.');
  assert.equal(path.normalize(value), value, 'Acceptance paths must be canonical.');
  let ancestor = root;
  assert.ok(!fs.lstatSync(ancestor).isSymbolicLink(), 'Acceptance paths must not traverse symbolic links.');
  for (const segment of path.relative(root, path.dirname(value)).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, segment);
    const parent = fs.lstatSync(ancestor);
    assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), 'Acceptance paths must not traverse symbolic links.');
  }
  const stat = fs.lstatSync(value);
  assert.ok(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'Acceptance path has the wrong file type.');
  assert.equal(fs.realpathSync(value), value, 'Acceptance paths must not traverse symbolic links.');
  return value;
}

/** Pure source transform exported only for fail-closed instrumentation tests. */
function instrumentPrivateHostSource(source, { assets, preload }) {
  assert.equal(typeof source, 'string', 'Acceptance source is required.');
  const syntax = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(syntax.parseDiagnostics.length, 0, 'Acceptance source must parse successfully.');
  const gates = [];
  const entries = [];
  const conversionEntries = [];
  const preloads = [];
  const distributions = [];
  let existingDriver = false;
  const isIdentifier = (node, name) => ts.isIdentifier(node) && node.text === name;
  const isJoinedFile = (node, name) => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression) && isIdentifier(node.expression.expression, 'path')
    && isIdentifier(node.expression.name, 'join') && node.arguments.length === 2
    && isIdentifier(node.arguments[0], '__dirname') && ts.isStringLiteral(node.arguments[1])
    && node.arguments[1].text === name;
  const visit = node => {
    if (isIdentifier(node, DRIVER)) { existingDriver = true; }
    if (ts.isVariableDeclaration(node) && isIdentifier(node.name, 'PRIVATE_HUB_UI_READY')) { gates.push(node); }
    if (isIdentifier(node, 'openPrivateHubFromNative')) { entries.push(node); }
    if (isIdentifier(node, 'createPrivateCopyFromNative')) { conversionEntries.push(node); }
    if (isJoinedFile(node, 'preload.js')) { preloads.push(node); }
    if (isJoinedFile(node, 'dist')) { distributions.push(node); }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  assert.equal(existingDriver, false, 'Production source must not contain the acceptance driver.');
  assert.equal(gates.length, 1, 'Expected one private readiness declaration.');
  const gate = gates[0];
  const readiness = gate.initializer;
  assert.ok(ts.isVariableDeclarationList(gate.parent) && (gate.parent.flags & ts.NodeFlags.Const)
    && readiness && ts.isBinaryExpression(readiness)
    && readiness.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ts.isPropertyAccessExpression(readiness.left) && isIdentifier(readiness.left.expression, 'process')
    && isIdentifier(readiness.left.name, 'platform') && ts.isStringLiteral(readiness.right)
    && readiness.right.text === 'darwin', 'The production readiness gate must remain the macOS platform check.');
  const nativeRegistration = (references, key, label) => {
    assert.equal(references.length, 2, `The production ${label} entry must have one native registration.`);
    const declaration = references.find(node => ts.isFunctionDeclaration(node.parent) && node.parent.name === node);
    const callback = references.find(node => ts.isPropertyAssignment(node.parent) && node.parent.initializer === node
      && isIdentifier(node.parent.name, key));
    assert.ok(declaration && callback, `Expected the production ${label} entry declaration and native callback.`);
    const object = callback.parent.parent;
    assert.ok(ts.isObjectLiteralExpression(object) && ts.isCallExpression(object.parent)
      && isIdentifier(object.parent.expression, 'createPrivateHubMenu') && object.parent.arguments.length === 1
      && object.parent.arguments[0] === object, `The production ${label} entry must belong to the native menu builder.`);
    return object;
  };
  assert.equal(nativeRegistration(entries, 'open', 'private'), nativeRegistration(conversionEntries, 'create', 'conversion'),
    'The production native entries must share one menu registration.');
  assert.equal(preloads.length, 1, 'Expected one ordinary preload path.');
  const preloadPath = preloads[0];
  assert.ok(ts.isPropertyAssignment(preloadPath.parent) && isIdentifier(preloadPath.parent.name, 'preload')
    && preloadPath.parent.initializer === preloadPath, 'The ordinary preload path must remain a window option.');
  assert.equal(distributions.length, 1, 'Expected one ordinary app asset path.');
  const distributionPath = distributions[0];
  assert.ok(ts.isCallExpression(distributionPath.parent) && isIdentifier(distributionPath.parent.expression, 'registerTheatrumProtocols')
    && distributionPath.parent.arguments[0] === distributionPath, 'The app asset path must remain the protocol root.');
  const changes = [
    { node: preloadPath, value: JSON.stringify(preload) },
    { node: distributionPath, value: JSON.stringify(assets) },
  ].sort((left, right) => right.node.getStart(syntax) - left.node.getStart(syntax));
  let transformed = source;
  for (const { node, value } of changes) {
    transformed = transformed.slice(0, node.getStart(syntax)) + value + transformed.slice(node.end);
  }
  // These capabilities exist only in this in-memory test compilation. The
  // shipped module, native menu, IPC registration and platform admission are unchanged.
  transformed += `\nexports.${DRIVER} = Object.freeze({
    openPrivateHubFromNative, createPrivateCopyFromNative, requestCatalogueOpenFromSystem,
    get window() { return win; },
    get workspace() { return privateApplicationWorkspace; },
    get sources() { return sourceFolderConnections; },
    get ready() { return rendererStartupComplete; },
    get queue() { return catalogueOpenQueue; }
  });\n`;
  const result = ts.transpileModule(transformed, { fileName: 'main.ts', reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true } });
  assert.ok(!result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), 'Acceptance compilation failed.');
  return result.outputText;
}

/** Compile actual main in memory; callers retain its repository module identity. */
function compilePrivateHost({ repository, assets, preload }) {
  const root = canonical(repository, WORKSPACE, true);
  const temporary = canonical(path.join(root, 'tmp'), root, true);
  canonical(assets, temporary, true);
  canonical(path.join(assets, 'index.html'), assets, false);
  canonical(preload, temporary, false);
  const main = canonical(path.join(root, 'main.ts'), root, false);
  const source = fs.readFileSync(main, 'utf8');
  const compiled = instrumentPrivateHostSource(source, { assets, preload });
  assert.equal(fs.readFileSync(main, 'utf8'), source, 'Production source changed while preparing acceptance.');
  return compiled;
}

module.exports = { compilePrivateHost, instrumentPrivateHostSource };
