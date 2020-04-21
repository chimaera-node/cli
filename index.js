#!/usr/bin/env node

const _ = require('rubico')
const fse = require('fs-extra')
const nodePath = require('path')
const execa = require('execa')
const pRetry = require('p-retry')
const semver = require('semver')
const columnify = require('columnify')
const ProgressBar = require('progress')
const git = require('./git')

const prettifyJSON = x => JSON.stringify(x, null, 2)

const USAGE = [
  'usage: chimaera [--version] [-v] [--help] [-h] <command> [<args>]',
  '',
  'commands:',
  '',
  '    list, ls                      list all modules',
  '    s[tatus]                      git status on all modules',
  '    ch[eckout] <branch>           conservative git checkout branch for all modules',
  '    fetch                         fetch remotes for all modules',
  '    merge                         conservative git merge current branch with upstream for all modules',
  '    pull                          conservative git pull upstream into current branch for all modules',
  '    push                          conservative git push current branch to upstream for all modules',
  '    dist <major|minor|patch>      version bump && publish all modules, skip unchanged modules',
  '    clean                         git clean -fxdq for all modules',
  '    i[nstall]                     install all module dependencies into module local node_modules, does not create package-lock',
  '    link, ln                      symlink all modules selectively into all modules\' local node_modules',
  // '    test <path|module>            run module tests defined by test script or mocha at module root',
  // '    run <script> <path|module>    run module script',
].join('\n')

// path => package
const getPackage = _.flow(
  x => nodePath.join(x, 'package.json'),
  fse.readFile,
  _.toString,
  JSON.parse,
)

// path => package_lock
const getPackageLock = _.flow(
  x => nodePath.join(x, 'package-lock.json'),
  fse.readFile,
  _.toString,
  JSON.parse,
)

// { path, package } => status
const writePackage = _.flow(
  _.diverge([
    _.flow(_.get('path'), x => nodePath.join(x, 'package.json')),
    _.flow(_.get('package'), prettifyJSON, x => `${x}\n`),
  ]),
  _.spread(fse.writeFile),
)

const writePackageLock = _.flow(
  _.diverge([
    _.flow(_.get('path'), x => nodePath.join(x, 'package-lock.json')),
    _.flow(_.get('package_lock'), prettifyJSON, x => `${x}\n`),
  ]),
  _.spread(fse.writeFile),
)

// { paths } => [module_path]
const findModules = _.flow(
  _.get('paths'),
  _.map(_.diverge([
    _.id,
    _.tryCatch(x => fse.readdir(x), _.noop),
  ])),
  _.filter(_.flow(_.get(1), _.exists)),
  _.map(
    _.switch(
      _.and(
        _.flow(_.get(1), _.has('.git')),
        _.flow(_.get(1), _.has('package.json')),
      ),
      _.get(0),
      x => findModules({
        paths: _.map.sync(y => nodePath.join(x[0], y))(x[1]),
      }),
    ),
  ),
  _.flattenAll,
  _.uniq,
)

// home_path => string => string
const replaceHome = home => _.replaceOne(home, '~')

const checkSlmPath = _.switch(
  _.get('SLM_PATH')(process.env),
  _.noop,
  () => console.warn(
    'WARNING: SLM_PATH not set, using ~ (this could be prohibitively slow)',
  ),
)

// { command } => status
const notACommand = _.flow(
  _.get('command'),
  x => `${x} is not a command. See slm --help.`,
  console.log,
)

// module_path => info
const getInfo = _.flow(
  _.diverge({
    path: _.id,
    fmt_path: replaceHome(process.env.HOME),
    repo: _.tryCatch(git.getRepo, console.error),
    origin_url: _.tryCatch(git.getRemoteUrl('origin'), console.error),
    tags: _.tryCatch(git.getTags, console.error),
    branch: _.tryCatch(git.getCurrentBranchName, console.error),
    status: _.tryCatch(git.status, console.error),
    ahead_behind: _.tryCatch(git.getCurrentAheadBehind, console.error),
    package: _.tryCatch(getPackage, _.noop),
    package_lock: _.tryCatch(getPackageLock, _.noop),
  }),
  _.put(
    ['module', _.get('package.name')],
    ['version', _.get('package.version')],
    ['vmodule', _.flow(
      _.diverge([
        _.get('package.name'),
        _.get('package.version'),
      ]),
      _.join('@'),
    )],
    ['semver', _.flow(
      _.get('package.version'),
      x => `v${x}`,
    )],
  ),
)

// { path } => info
const refreshInfo = _.flow(_.get('path'), getInfo)

// { paths } => ()
const list = _.flow(
  findModules,
  _.map(_.flow(getInfo, _.put(['path', _.get('fmt_path')]))),
  _.sortBy('module', 1),
  x => columnify(x, {
    columns: ['module', 'version', 'path', 'branch'],
    minWidth: 20,
  }),
  console.log,
)

// { ahead, behind } => string
const fmtAheadBehind = x => {
  let y = []
  if (x.ahead > 0) y.push(`ahead ${x.ahead}`)
  if (x.behind > 0) y.push(`behind ${x.behind}`)
  if (_.isEmpty(y)) return ''
  return `[${_.join(', ')(y)}]`
}

// [file_path, status_flag] => string
const fmtStatus = x => `\n${x[1]} ${x[0]}`

// { path, branch, ahead_behind, status: [[file_path, status_flag]] => string
const fmtRepo = _.flow.sync(
  _.diverge.sync([
    _.flow.sync(_.get('path'), replaceHome(process.env.HOME)),
    _.get('branch'),
    _.flow.sync(_.get('ahead_behind', {}), fmtAheadBehind),
    _.flow.sync(_.get('status', []), _.map.sync(fmtStatus), _.join('')),
  ]),
  _.join(' '),
)

// { paths } => [git_status]
const status = _.flow(
  findModules,
  _.map(getInfo),
  _.filter(
    _.or(
      _.flow(_.get('ahead_behind'), _.any(_.not(_.eq(_.id, 0)))),
      _.flow(_.get('status'), _.not(_.isEmpty)),
    ),
  ),
  _.map(_.flow(fmtRepo, console.log)),
)

// { paths, argv } => ()
const checkout = x => {
  const branch = _.get(['argv', 0])(x)
  return _.flow(
    findModules,
    _.map(getInfo),
    _.map(_.tryCatch(
      _.effect(git.checkout(branch)),
      _.noop,
    )),
    _.filter(_.exists),
    _.map(_.flow(
      refreshInfo,
      _.diverge([_.get('module'), _.get('branch')]),
      x => `switched to branch ${x[1]} ${x[0]}`,
      console.log,
    )),
  )(x)
}

const spaces = l => {
  let s = ''
  for (let i = 0; i < l; i++) s += ' '
  return s
}

const neatLogCollection = (x, lineStart = '') => {
  if (x.length === 0) return
  process.stdout.write(lineStart)
  process.stdout.write(`${x[0]}`)
  let curLineLength = lineStart.length + x[0].length
  for (const s of x.slice(1)) {
    if (curLineLength + s.length > process.stdout.columns - 20) {
      const nextLine = `\n${spaces(lineStart.length)}${s}`
      process.stdout.write(nextLine)
      curLineLength = nextLine.length
    } else {
      process.stdout.write(`  ${s}`)
      curLineLength += s.length
    }
  }
  process.stdout.write('\n\n')
}

// { paths } => [git_status]
const fetchAll = _.flow(
  findModules,
  _.map(getInfo),
  x => {
    const bar = new ProgressBar(':bar :current/:total modules', {
      head: '~',
      complete: '~',
      incomplete: ' ',
      total: x.length,
      width: process.stdout.columns - 30,
    })
    neatLogCollection(
      _.map.sync(_.get('origin_url'))(x),
      `fetching (${x.length}) `,
    )
    bar.render({ module: '' })
    return _.map(_.flow(
      _.tryCatch(
        x => execa('git', [
          `--git-dir=${nodePath.join(x.path, '.git')}`,
          `--work-tree=${x.path}`,
          'fetch',
          '--all',
        ]),
        e => bar.interrupt(`fetch failed: ${e}`),
      ),
      () => bar.tick(),
    ))(x)
  },
)

// { paths } => ()
const merge = _.flow(
  findModules,
  _.map(getInfo),
  _.map(_.switch(
    _.and(
      _.flow(_.get('branch'), _.split('...'), _.size, _.eq(_.id, 2)),
      _.flow(_.get('status'), _.isEmpty),
      _.flow(_.get('ahead_behind'), _.gt(_.get('behind'), 0)),
      _.flow(_.get('ahead_behind'), _.eq(_.get('ahead'), 0)),
    ),
    _.flow(
      _.tryCatch(
        _.effect(git.merge),
        e => console.error(`merge failed: ${e}`),
      ),
      _.diverge([_.get('module'), _.get('branch')]),
      _.join(' '),
      x => `merged ${x}`,
      console.log,
    ),
    _.noop,
  )),
)

// { paths, argv } => ()
const push = input => {
  const isDryRun = _.or.sync(_.has('--dry-run'), _.has('-n'))(input.argv)
  return _.flow(
    findModules,
    _.map(getInfo),
    _.filter(_.and(
      _.flow(_.get('branch'), _.split('...'), _.size, _.eq(_.id, 2)),
      _.flow(_.get('ahead_behind'), _.gt(_.get('ahead'), 0)),
      _.flow(_.get('ahead_behind'), _.eq(_.get('behind'), 0)),
    )),
    _.effect(x => neatLogCollection(
      _.map.sync(_.flow.sync(
        _.diverge.sync([
          _.get('origin_url'),
          _.flow.sync(_.get('branch'), _.split('...'), _.get(0)),
        ]),
        x => `${x[0]}(${x[1]})`,
      ))(x),
      `pushing (${x.length}) `,
    )),
    x => {
      const bar = new ProgressBar(':bar :current/:total modules', {
        head: '~',
        complete: '~',
        incomplete: ' ',
        total: x.length,
        width: process.stdout.columns - 30,
      })
      if (x.length > 0) bar.render()
      return _.map(_.flow(
        _.switch(isDryRun, _.id, _.tryCatch(
          _.effect(x => execa('git', [
            `--git-dir=${nodePath.join(x.path, '.git')}`,
            `--work-tree=${x.path}`,
            'push',
          ])),
          console.error,
        )),
        _.effect(() => bar.tick()),
      ))(x)
    },
  )(input)
}

// bump => { path, package, package_lock, is_dry_run, version_bump } => { ... }
const bumpVersion = _.flow(
  _.put(['next_version', _.flow(
    _.diverge([
      _.get('package.version'),
      _.get('version_bump'),
    ]),
    _.spread(semver.inc),
  )]),
  _.put(
    ['vmodule', _.flow(
      _.diverge([
        _.get('package.name'),
        _.get('next_version'),
      ]),
      _.join('@'),
    )],
    ['package', x => _.flow(
      _.get('package'),
      _.put(['version', _.get('next_version')(x)]),
    )(x)],
    ['package_lock', _.switch(
      _.has('package_lock'),
      x => _.flow(
        _.get('package_lock'),
        _.put(['version', _.get('next_version')(x)]),
      )(x),
      _.noop,
    )],
  ),
  _.switch(
    _.get('is_dry_run'),
    _.id,
    _.effect(_.series(
      writePackage,
      _.switch(_.has('package_lock'), writePackageLock, _.noop),
      _.tryCatch(
        x => execa('git', [
          `--git-dir=${nodePath.join(x.path, '.git')}`,
          `--work-tree=${x.path}`,
          'add',
          '.',
        ]),
        console.error,
      ),
      _.tryCatch(
        x => execa('git', [
          `--git-dir=${nodePath.join(x.path, '.git')}`,
          `--work-tree=${x.path}`,
          'commit',
          '-m',
          x.next_version,
        ]),
        console.error,
      ),
      _.tryCatch(
        x => execa('git', [
          `--git-dir=${nodePath.join(x.path, '.git')}`,
          `--work-tree=${x.path}`,
          'tag',
          `v${x.next_version}`,
        ]),
        console.error,
      ),
      _.tryCatch(
        x => execa('git', [
          `--git-dir=${nodePath.join(x.path, '.git')}`,
          `--work-tree=${x.path}`,
          'push',
          '-f',
          'origin',
          `v${x.next_version}`,
        ]),
        console.error,
      ),
    )),
  ),
)

// { paths, argv } => ()
const dist = input => {
  const versionBump = _.flow.sync(
    _.get(0),
    _.switch.sync(
      _.member(['major', 'minor', 'patch']),
      _.id,
      _.noop,
    ),
  )(input.argv)
  if (!versionBump) return console.error('Error: <major|minor|patch> required')
  const isDryRun = _.or.sync(_.has('--dry-run'), _.has('-n'))(input.argv)
  return _.flow(
    findModules,
    _.map(getInfo),
    _.filter(_.and(
      _.eq(_.get('branch'), 'master...origin/master'),
      x => _.switch(
        _.flow(
          _.get('tags', []),
          _.has(_.get('semver')(x)),
        ),
        _.flow(
          _.get('path'),
          git.descendantOfHead(_.get('semver')(x)),
        ),
        false,
      )(x),
      _.flow(_.get('status'), _.isEmpty),
      _.flow(_.get('ahead_behind'), _.eq(_.get('behind'), 0)),
      _.flow(_.get('ahead_behind'), _.gte(_.get('ahead'), 0)),
      _.not(_.get('package.nopack')),
    )),
    _.effect(x => neatLogCollection(
      _.map.sync(_.get('vmodule'))(x),
      `bumping ${versionBump} & publishing (${x.length}) `,
    )),
    _.map(_.flow(
      _.put(
        ['version_bump', versionBump],
        ['is_dry_run', isDryRun],
      ),
      bumpVersion,
    )),
    async x => {
      const bar = new ProgressBar(':bar :current/:total modules', {
        head: '~',
        complete: '~',
        incomplete: ' ',
        total: x.length,
        width: process.stdout.columns - 30,
      })
      if (x.length > 0) bar.render()
      return _.map(_.flow(
        _.switch(
          _.get('is_dry_run'),
          _.flow(
            _.get('vmodule'),
            x => `+ ${x}`,
          ),
          _.tryCatch(
            _.flow(
              x => pRetry(() => execa('npm', ['publish', x.path]), {
                onFailedAttempt: e => bar.interrupt(
                  `publish failed for ${x.vmodule}, retrying ${e.attemptNumber - 1}/5`,
                ),
                retries: 5,
              }),
              _.get('stdout'),
            ),
            e => bar.interrupt(`giving up publish: ${e}`)
          ),
        ),
        _.effect(() => bar.tick()),
      ))(x)
    },
    _.map(x => console.log(x)),
  )(input)
}

// { paths } => ()
const clean = _.flow(
  findModules,
  _.map(getInfo),
  _.map(_.flow(
    _.effect(_.tryCatch(
      x => execa('git', [
        `--git-dir=${nodePath.join(x.path, '.git')}`,
        `--work-tree=${x.path}`,
        'clean',
        '-fxdq',
      ]),
      e => console.error(`clean failed: ${e}`),
    )),
    x => `cleaned ${x.path}`,
    console.log,
  )),
)

// { paths, argv } => ()
const install = input => {
  const isDryRun = _.or.sync(_.has('--dry-run'), _.has('-n'))(input.argv)
  return _.flow(
    findModules,
    _.map(getInfo),
    _.effect(x => neatLogCollection(
      _.map.sync(_.get('module'))(x),
      `installing (${x.length}) `,
    )),
    x => {
      const bar = new ProgressBar(':bar :current/:total modules', {
        head: '~',
        complete: '~',
        incomplete: ' ',
        total: x.length,
        width: process.stdout.columns - 30,
      })
      if (x.length > 0) bar.render()
      return _.map(_.flow(
        _.switch(isDryRun, _.id, _.effect(_.tryCatch(
          x => execa('npm', [
            'i',
            `--cache=${nodePath.join(x.path, '.npm')}`,
            '-C',
            x.path,
            '--no-package-lock',
          ]),
          e => bar.interrupt(`install failed: ${e}`),
        ))),
        () => bar.tick(),
      ))(x)
    },
  )(input)
}

// { paths, argv } => ()
const link = input => {
  const isDryRun = _.or.sync(_.has('--dry-run'), _.has('-n'))(input.argv)
  return _.flow(
    findModules,
    _.map(getInfo),
    x => {
      const moduleStore = _.reduce.sync(
        (a, b) => { a[b.module] = b; return a },
        {},
      )(x)
      return _.map(_.put(['symlinks', _.flow(
        _.diverge([
          _.get('package.dependencies', {}),
          _.get('package.devDependencies', {}),
        ]),
        _.map(Object.keys),
        _.flatten,
        _.map(_.lookup(moduleStore)),
        _.filter(_.exists),
      )]))(x)
    },
    _.filter(_.flow(_.get('symlinks'), _.gt(_.size, 0))),
    _.switch(isDryRun, _.id, _.effect(_.map(mod => _.flow(
      _.get('symlinks'),
      _.map(_.flow(
        _.diverge([
          _.get('path'),
          _.flow(
            _.diverge([_.get('path')(mod), 'node_modules', _.get('module')]),
            _.spread(nodePath.join),
          ),
        ]),
        _.effect(_.tryCatch(
          _.flow(_.get(1), fse.remove),
          e => console.error(`remove failed: ${e}`),
        )),
        _.effect(_.tryCatch(
          _.spread(fse.ensureSymlink),
          e => console.error(`symlink failed: ${e}`),
        )),
      )),
    )(mod)))),
    _.map(_.flow(
      x => {
        let y = ''
        const [first, ...rest] = x.symlinks
        y += `┌ ${first.fmt_path} (${first.module})`
        for (const a of rest) {
          y += `\n├ ${a.fmt_path} (${a.module})`
        }
        y += `\n└┄► ${nodePath.join(x.fmt_path, 'node_modules')}`
        return y
      },
      console.log,
    )),
  )(input)
}

const main = _.flow(
  _.switch(
    _.or(
      _.flow(_.get('command'), _.not(_.exists)),
      _.eq(_.get('command'), '--help'),
      _.eq(_.get('command'), '-h'),
    ),
    _.flow(_.get('usage'), console.log),
    _.or(
      _.eq(_.get('command'), '--version'),
      _.eq(_.get('command'), '-v'),
    ),
    _.flow(
      _.get('__dirname'),
      getPackage,
      _.get('version'),
      x => `v${x}`,
      console.log,
    ),
    _.or(
      _.eq(_.get('command'), 'list'),
      _.eq(_.get('command'), 'ls'),
    ),
    _.series(checkSlmPath, list),
    _.or(
      _.eq(_.get('command'), 'status'),
      _.eq(_.get('command'), 's'),
    ),
    _.series(checkSlmPath, status),
    _.or(
      _.eq(_.get('command'), 'checkout'),
      _.eq(_.get('command'), 'ch'),
    ),
    _.series(checkSlmPath, checkout),
    _.eq(_.get('command'), 'fetch'),
    _.series(checkSlmPath, fetchAll),
    _.eq(_.get('command'), 'merge'),
    _.series(checkSlmPath, merge),
    _.eq(_.get('command'), 'pull'),
    _.series(fetchAll, merge),
    _.or(
      _.eq(_.get('command'), 'push'),
      _.eq(_.get('command'), 'p'),
    ),
    _.series(checkSlmPath, push),
    _.eq(_.get('command'), 'dist'),
    _.series(checkSlmPath, dist),
    _.eq(_.get('command'), 'clean'),
    _.series(checkSlmPath, clean),
    _.or(
      _.eq(_.get('command'), 'install'),
      _.eq(_.get('command'), 'i'),
    ),
    _.series(checkSlmPath, install),
    _.or(
      _.eq(_.get('command'), 'link'),
      _.eq(_.get('command'), 'ln'),
    ),
    _.series(checkSlmPath, link),
    notACommand,
  ),
)

main({
  paths: _.split(':')(process.env.SLM_PATH || process.env.HOME),
  command: _.get(2)(process.argv),
  argv: _.slice(3)(process.argv),
  usage: USAGE,
  __dirname,
})
