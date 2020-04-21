const _ = require('rubico')
const fs = require('fs')
const nodePath = require('path')
const nodegit = require('nodegit')
const columnify = require('columnify')

const git = {}

const appendPath = s => x => nodePath.join(x, s)

// module_path => nodegit_repo
const getRepo = _.flow(appendPath('.git'), nodegit.Repository.open)

git.getRepo = getRepo

// nodegit_ref => nodegit_ref
const getUpstreamBranch = x => nodegit.Branch.upstream(x).catch(_.noop)

git.getUpstreamBranch = getUpstreamBranch

const callProp = (k, ...args) => x => _.toFn(_.get(k)(x)).bind(x)(...args)

// module_path => [nodegit_ref, nodegit_ref]
const getHead = _.flow(
  getRepo,
  callProp('head'),
  _.diverge([_.id, getUpstreamBranch]),
)

git.getHead = getHead

// module_path => string
const getCurrentBranchName = _.flow(
  getHead,
  _.map(callProp('shorthand')),
  _.filter(_.exists),
  _.join('...'),
)

git.getCurrentBranchName = getCurrentBranchName

// nodegit_status => string
const getStatusFlag = x => {
  let y = ''
  if (x.isConflicted) y = 'C'
  if (x.isDeleted) y = 'D'
  if (x.isIgnored) y = 'I'
  if (x.isModified) y = 'M'
  if (x.isNew) y = '??'
  if (x.isRenamed) y = 'R'
  if (x.isTypechange) y = 'T'
  return y.padStart(2, ' ')
}

git.getStatusFlag = getStatusFlag

// module_path => [[local_file_path, status_flag]]
const status = _.flow(
  getRepo,
  callProp('getStatusExt'),
  _.map(_.map(x => _.toFn(x)())),
  _.map(_.diverge([_.get('path'), getStatusFlag])),
)

git.status = status

// module_path => { ahead: int, behind: int }
const getCurrentAheadBehind = _.flow(
  _.diverge([
    getRepo,
    _.flow(getHead, _.map(callProp('target'))),
  ]),
  _.flatten,
  _.switch(_.every(_.exists), x => nodegit.Graph.aheadBehind(...x), {}),
)

git.getCurrentAheadBehind = getCurrentAheadBehind

// commit-ish => path => string
const getCommit = s => _.flow(
  getRepo,
  callProp('getReference', s),
  callProp('target'),
  _.toString,
)

git.getCommit = getCommit

// commit-ish => module_path => { ahead, behind }
const descendantOfHead = s => _.flow(
  getRepo,
  _.diverge([
    _.id,
    _.flow(
      callProp('head'),
      callProp('peel', nodegit.Object.TYPE.COMMIT),
    ),
    _.flow(
      callProp('getReference', s),
      callProp('peel', nodegit.Object.TYPE.COMMIT),
    ),
  ]),
  _.switch(_.every(_.exists), x => nodegit.Graph.descendantOf(...x), 0),
  Boolean,
)

git.descendantOfHead = descendantOfHead

// branch => { path } => ()
const checkout = branch => _.flow(
  _.get('path'),
  getRepo,
  callProp('checkoutBranch', branch),
)

git.checkout = checkout

// module_path => module_path
const fetchAll = _.flow(
  getRepo,
  callProp('fetchAll', {
    callbacks: {
      certificateCheck: () => 0,
      credentials: (url, username) => {
        return nodegit.Cred.sshKeyNew(
          username,
          nodePath.join(process.env.HOME, '.ssh/id_rsa.pub'),
          nodePath.join(process.env.HOME, '.ssh/id_rsa'),
          '',
        )
      },
    },
  }),
)

git.fetchAll = fetchAll

// { path, branch } => ()
const merge = _.flow(
  _.diverge([
    _.flow(_.get('path'), getRepo),
    _.flow(_.get('branch'), _.split('...')),
  ]),
  x => callProp('mergeBranches', ...x[1])(x[0]),
)

git.merge = merge

// module_path => bool
const getTags = _.flow(
  getRepo,
  nodegit.Tag.list,
)

git.getTags = getTags

// remote_name => { path } => remote_url
const getRemoteUrl = name => _.flow(
  getRepo,
  callProp('getRemote', name),
  callProp('url'),
  _.split('@'),
  _.get(1),
)

git.getRemoteUrl = getRemoteUrl

module.exports = git
