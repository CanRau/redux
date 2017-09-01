var CrossTabClient = require('logux-client/cross-tab-client')
var isFirstOlder = require('logux-core/is-first-older')
var createStore = require('redux').createStore

function hackReducer (reducer) {
  return function (state, action) {
    if (action.type === 'logux/state') {
      return action.state
    } else {
      return reducer(state, action)
    }
  }
}

function warnBadUndo (id) {
  var json = JSON.stringify(id)
  console.warn(
    'Logux can not undo action ' + json + ', because log does not ' +
    'contain this action. Maybe action was cleaned.'
  )
}

function checkReasons (meta) {
  if (!meta || (!meta.reasons && !meta.keepLast)) {
    throw new Error('All Logux action must have meta.reasons or meta.keepLast')
  }
  if (!meta.reasons) meta.reasons = []
}

/**
 * Creates Logux client and connect it to Redux createStore function.
 *
 * @param {object} config Logux Client config.
 * @param {string|Connection} config.server Server URL.
 * @param {string} config.subprotocol Client subprotocol version
 *                                    in SemVer format.
 * @param {number|string|false} config.userId User ID. Pass `false` if no user.
 * @param {any} [config.credentials] Client credentials for authentication.
 * @param {string} [config.prefix="logux"] Prefix for `IndexedDB` database
 *                                         to run multiple Logux instances
 *                                         in the same browser.
 * @param {number} [config.timeout=20000] Timeout in milliseconds
 *                                        to break connection.
 * @param {number} [config.ping=10000] Milliseconds since last message to test
 *                                     connection by sending ping.
 * @param {Store} [config.store] Store to save log data. `IndexedStore`
 *                               by default (if available)
 * @param {number} [config.minDelay=1000] Minimum delay between reconnections.
 * @param {number} [config.maxDelay=5000] Maximum delay between reconnections.
 * @param {number} [config.attempts=Infinity] Maximum reconnection attempts.
 * @param {bool} [config.allowDangerousProtocol=false] Do not show warning
 *                                                     when using 'ws://'
 *                                                     in production.
 * @param {number} [config.dispatchHistory=1000] How many actions, added by
 *                                              {@link LoguxStore#dispatch}
 *                                              will be kept.
 * @param {number} [config.saveStateEvery=50] How often save state to history.
 * @param {checker} [config.onMissedHistory] Callback when there is no history
 *                                           to replay actions accurate.
 *
 * @return {storeCreator} Redux createStore compatible function.
 */
function createLoguxCreator (config) {
  if (!config) config = { }

  var dispatchHistory = config.dispatchHistory || 1000
  delete config.dispatchHistory
  var saveStateEvery = config.saveStateEvery || 50
  delete config.saveStateEvery
  var onMissedHistory = config.onMissedHistory
  delete config.onMissedHistory

  var client = new CrossTabClient(config)
  var log = client.log

  /**
   * Creates Redux store and connect Logux Client to it.
   *
   * @param {function} reducer Redux reducer.
   * @param {any} preloadedState Initial Redux state.
   * @param {function} enhancer Redux middleware.
   *
   * @return {object} Redux store with Logux hacks.
   */
  return function createLoguxStore (reducer, preloadedState, enhancer) {
    var store = createStore(hackReducer(reducer), preloadedState, enhancer)

    store.client = client
    store.log = log
    var history = { }

    var actionCount = 0
    function saveHistory (meta) {
      actionCount += 1
      if (saveStateEvery === 1 || actionCount % saveStateEvery === 1) {
        history[meta.id.join('\t')] = store.getState()
      }
    }

    var originReplace = store.replaceReducer
    store.replaceReducer = function replaceReducer (newReducer) {
      reducer = newReducer
      return originReplace(hackReducer(newReducer))
    }

    var prevMeta
    var originDispatch = store.dispatch
    store.dispatch = function dispatch (action) {
      var meta = {
        id: log.generateId(),
        tab: store.client.id,
        reasons: ['tab' + store.client.id],
        dispatch: true
      }
      log.add(action, meta)

      prevMeta = meta
      originDispatch(action)
      saveHistory(meta)
    }

    store.dispatch.local = function local (action, meta) {
      checkReasons(meta)
      meta.tab = client.id
      return log.add(action, meta)
    }

    store.dispatch.crossTab = function crossTab (action, meta) {
      checkReasons(meta)
      return log.add(action, meta)
    }

    store.dispatch.sync = function sync (action, meta) {
      checkReasons(meta)
      meta.sync = true
      meta.reasons.push('waitForSync')
      return log.add(action, meta)
    }

    function replaceState (state, actions) {
      var newState = actions.reduceRight(function (prev, i) {
        var changed = reducer(prev, i[0])
        if (history[i[1]]) history[i[1]] = changed
        return changed
      }, state)
      originDispatch({ type: 'logux/state', state: newState })
    }

    function replay (actionId) {
      var until = actionId.join('\t')

      var ignore = { }
      var actions = []
      var replayed = false
      var newAction
      var collecting = true

      log.each(function (action, meta) {
        var id = meta.id.join('\t')

        if (collecting || !history[id]) {
          if (action.type === 'logux/undo') {
            ignore[action.id.join('\t')] = true
            return true
          }

          if (!ignore[id]) actions.push([action, id])
          if (id === until) {
            newAction = action
            collecting = false
          }

          return true
        } else {
          replayed = true
          replaceState(history[id], actions)
          return false
        }
      }).then(function () {
        if (replayed) return
        if (onMissedHistory) onMissedHistory(newAction)

        var full = actions.slice(0)
        while (actions.length > 0) {
          var last = actions[actions.length - 1]
          actions.pop()
          if (history[last[1]]) {
            replayed = true
            replaceState(history[last[1]], actions.concat([
              [newAction, until]
            ]))
            break
          }
        }

        if (!replayed) {
          replaceState(preloadedState, full)
        }
      })
    }

    log.on('preadd', function (action, meta) {
      if (action.type === 'logux/undo' && meta.reasons.length === 0) {
        meta.reasons.push('reasonsLoading')
      }
    })

    var lastAdded = 0
    var dispatchCalls = 0
    client.on('add', function (action, meta) {
      if (meta.added > lastAdded) lastAdded = meta.added
      if (meta.dispatch) {
        dispatchCalls += 1
        if (lastAdded > dispatchHistory && dispatchCalls % 25 === 0) {
          log.removeReason('tab' + store.client.id, {
            maxAdded: lastAdded - dispatchHistory
          })
        }
        return
      }

      if (action.type === 'logux/undo') {
        var reasons = meta.reasons
        log.byId(action.id).then(function (result) {
          if (result[0]) {
            if (reasons.length === 1 && reasons[0] === 'reasonsLoading') {
              log.changeMeta(meta.id, { reasons: result[1].reasons })
            }
            delete history[action.id.join('\t')]
            replay(action.id)
          } else {
            log.changeMeta(meta.id, { reasons: [] })
            warnBadUndo(action.id)
          }
        })
      } else if (!meta.added) {
        prevMeta = meta
        originDispatch(action)
      } else if (isFirstOlder(prevMeta, meta)) {
        prevMeta = meta
        originDispatch(action)
        saveHistory(meta)
      } else {
        replay(meta.id)
      }
    })

    client.on('clean', function (action, meta) {
      delete history[meta.id.join('\t')]
    })

    client.sync.on('state', function () {
      if (client.sync.state === 'synchronized') {
        log.removeReason('waitForSync', { maxAdded: client.sync.lastSent })
      }
    })

    var previous = []
    var ignores = { }
    log.each(function (action, meta) {
      if (!meta.tab) {
        if (action.type === 'logux/undo') {
          ignores[action.id.join('\t')] = true
        } else if (!ignores[meta.id.join('\t')]) {
          previous.push(action)
        }
      }
    }).then(function () {
      if (previous.length > 0) {
        var newState = previous.reduceRight(function (state, i) {
          return reducer(state, i)
        }, store.getState())
        originDispatch({ type: 'logux/state', state: newState })
      }
    })

    return store
  }
}

module.exports = createLoguxCreator

/**
 * @callback storeCreator
 * @param {Function} reducer A function that returns the next state tree,
 *                           given the current state tree and the action
 *                           to handle.
 * @param {any} [preloadedState] The initial state.
 * @param {Function} [enhancer] The store enhancer.
 * @return {LoguxStore} Redux store with Logux extensions.
 */

/**
 * @callback checker
 * @param {Action} action The new action.
 */

/**
 * Redux store with Logux extensions.
 * @name LoguxStore
 * @class
 */
/**
 * Logux synchronization client.
 *
 * @name client
 * @type {CrossTabClient}
 * @memberof LoguxStore#
 */
/**
 * The Logux log.
 *
 * @name log
 * @type {Log}
 * @memberof LoguxStore#
 */
/**
 * Reads the state tree managed by the store.
 *
 * @return {any} The current state tree of your application.
 *
 * @name getState
 * @function
 * @memberof LoguxStore#
 */
/**
 * Adds a store change listener.
 *
 * @param {Function} listener A callback to be invoked on every new action.
 *
 * @returns {Function} A function to remove this change listener.
 *
 * @name subscribe
 * @function
 * @memberof LoguxStore#
 */
/**
 * Add action to log with Redux compatible API.
 *
 * You should use it only in legacy code.
 * There is noway to set metadata in this method.
 * As result there is no way to cleaning control.
 *
 * Use {@link dispatchLocal}, {@link dispatchCrossTab} or {@link dispatchSync}
 * instead.
 *
 * @param {Object} action A plain object representing “what changed”.
 *
 * @return {Object} For convenience, the same action object you dispatched.
 *
 * @property {dispatchLocal} local Add sync action to log and update
 *                                 store state. This action will be visible
 *                                 only for current tab.
 * @property {dispatchCrossTab} crossTab Add sync action to log and update
 *                                       store state. This action will be
 *                                       visible for all tabs.
 * @property {dispatchSync} sync Add sync action to log and update store state.
 *                               This action will be visible for server
 *                               and all browser tabs.
 *
 * @name dispatch
 * @function
 * @memberof LoguxStore#
 */
/**
 * Replaces the reducer currently used by the store to calculate the state.
 *
 * @param {Function} nextReducer The reducer for the store to use instead.
 *
 * @return {void}
 *
 * @name replaceReducer
 * @function
 * @memberof LoguxStore#
 */
/**
 * Interoperability point for observable/reactive libraries.
 *
 * @returns {observable} A minimal observable of state changes.
 *
 * @name observable
 * @function
 * @memberof LoguxStore#
 */

/**
 * Add local action to log and update store state.
 * This action will be visible only for current tab.
 *
 * @param {Action} action The new action.
 * @param {Meta} meta Action’s metadata.
 * @param {string[]} meta.reasons Code of reasons, why action should
 *                                be kept in log.
 *
 * @return {Promise} Promise when action will be saved to the log.
 *
 * @example
 * store.dispatch.local(
 *   { type: 'OPEN_MENU' },
 *   { reasons: ['lastMenu'] }
 * ).then(meta => {
 *   store.log.removeReason('lastMenu', { maxAdded: meta.added - 1 })
 * })
 *
 * @callback dispatchLocal
 */
/**
 * Add cross-tab action to log and update store state.
 * This action will be visible only for all tabs.
 *
 * @param {Action} action The new action.
 * @param {Meta} meta Action’s metadata.
 * @param {string[]} meta.reasons Code of reasons, why action should
 *                                be kept in log.
 *
 * @return {Promise} Promise when action will be saved to the log.
 *
 * @example
 * store.dispatch.crossTab(
 *   { type: 'CHANGE_FAVICON', favicon },
 *   { reasons: ['lastFavicon'] }
 * ).then(meta => {
 *   store.log.removeReason('lastFavicon', { maxAdded: meta.added - 1 })
 * })
 *
 * @callback dispatchCrossTab
 */
/**
 * Add sync action to log and update store state.
 * This action will be visible only for server and all browser tabs.
 *
 * @param {Action} action The new action.
 * @param {Meta} meta Action’s metadata.
 * @param {string[]} meta.reasons Code of reasons, why action should
 *                                be kept in log.
 *
 * @return {Promise} Promise when action will be saved to the log.
 *
 * @example
 * store.dispatch.crossTab(
 *   { type: 'CHANGE_NAME', name },
 *   { reasons: ['lastName'] }
 * ).then(meta => {
 *   store.log.removeReason('lastName', { maxAdded: meta.added - 1 })
 * })
 *
 * @callback dispatchSync
 */
