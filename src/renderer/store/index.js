import Vue from 'vue'
import Vuex from 'vuex'
import { createPersistedState } from 'vuex-electron'

import modules from './modules'
import migrate from './migrate'
import cleanup from './cleanup'
import isVersion1 from './helpers/is-version-1'

Vue.use(Vuex)

const persistedModuleNames = []

Object.keys(modules).forEach(moduleName => {
  const isPersisted = modules[moduleName].persisted !== false
  if (isPersisted) persistedModuleNames.push(moduleName)
})

const persistedKeys = ['version', ...persistedModuleNames]

const store = new Vuex.Store({
  state: {
    version: 2
  },
  modules,
  plugins: [
    !process.env.IS_WEB && createPersistedState()
  ].filter(Boolean),
  strict: process.env.NODE_ENV !== 'production',
  mutations: {
    CLEANUP(state) {
      cleanup(state, persistedModuleNames, persistedKeys)
    },
    MIGRATE(state) {
      migrate(state)
    },
    SET_VERSION(state, { version }) {
      state.version = version
    }
  }
})

console.log(store.state)

if (isVersion1(store.state)) {
  store.commit('SET_VERSION', { version: 1 })
}

store.commit('MIGRATE')
store.commit('CLEANUP')

export default store
