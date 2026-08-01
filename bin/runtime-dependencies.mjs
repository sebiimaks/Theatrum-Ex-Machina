function resolveLockedPackagePath(packages, parentPackagePath, dependencyName) {
  let currentParent = parentPackagePath;

  while (currentParent) {
    const nestedCandidate = `${currentParent}/node_modules/${dependencyName}`;
    if (packages[nestedCandidate]) {
      return nestedCandidate;
    }

    const parentNodeModulesIndex = currentParent.lastIndexOf('/node_modules/');
    currentParent = parentNodeModulesIndex === -1
      ? ''
      : currentParent.slice(0, parentNodeModulesIndex);
  }

  const rootCandidate = `node_modules/${dependencyName}`;
  return packages[rootCandidate] ? rootCandidate : null;
}

export function collectRuntimePackagePaths(packageLock) {
  const packages = packageLock.packages || {};
  const rootPackage = packages[''];
  if (!rootPackage) {
    throw new Error('package-lock.json does not contain its root package entry.');
  }

  const runtimePackagePaths = new Set();
  const dependencyQueue = Object.keys(rootPackage.dependencies || {}).map((dependencyName) => ({
    dependencyName,
    optional: false,
    parentPackagePath: '',
  }));

  while (dependencyQueue.length > 0) {
    const dependency = dependencyQueue.shift();
    const packagePath = resolveLockedPackagePath(
      packages,
      dependency.parentPackagePath,
      dependency.dependencyName,
    );

    if (!packagePath) {
      if (dependency.optional) {
        continue;
      }
      throw new Error(
        `Unable to resolve runtime dependency '${dependency.dependencyName}' from '${dependency.parentPackagePath || 'root'}'.`,
      );
    }
    if (runtimePackagePaths.has(packagePath)) {
      continue;
    }

    runtimePackagePaths.add(packagePath);
    const lockedPackage = packages[packagePath];
    for (const dependencyName of Object.keys(lockedPackage.dependencies || {})) {
      dependencyQueue.push({
        dependencyName,
        optional: false,
        parentPackagePath: packagePath,
      });
    }
    for (const dependencyName of Object.keys(lockedPackage.optionalDependencies || {})) {
      dependencyQueue.push({
        dependencyName,
        optional: true,
        parentPackagePath: packagePath,
      });
    }
  }

  return [...runtimePackagePaths].sort((firstPath, secondPath) => {
    const depthDifference = firstPath.split('/node_modules/').length
      - secondPath.split('/node_modules/').length;
    return depthDifference || firstPath.localeCompare(secondPath);
  });
}
