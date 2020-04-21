# chimaera
🧊 DevOps toolchain for multi-repos

## Configuration
Environment
```
# :-delimited list of paths for slm operation
# slm will recursively search these paths for modules
export CHIMAERA_PATH=/path/to/workspace1:/path/to/workspace2:/path/to/single/module
```

package.json
```
{
  ...,
  "nopack": true, // ignore this module for dists, defaults to false
  "scripts": {
    "test": "mocha ./test",
    "example-script": "example --flag1 arg1 --flag2 arg2 .",
    ...
  }
}
```

## Prerequisites
```
node >= 10
npm >= 6.8.0
git >= 2.11
```
