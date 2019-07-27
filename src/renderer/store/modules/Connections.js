import Vue from 'vue'
import * as k8s from '@kubernetes/client-node'
import * as net from 'net'
import killable from 'killable'
import * as Sentry from '@sentry/electron'

import { patchForward } from '../../lib/k8s-port-forwarding-patch'
import * as resourceKinds from '../../lib/constants/workload-types'
import { createToolset } from '../helpers/validations'
import * as connectionStates from '../../lib/constants/connection-states'
import { k8nApiPrettyError } from '../../lib/helpers/k8n-api-error'
import { netServerPrettyError } from '../../lib/helpers/net-server-error'
import { getServiceLabel } from '../../lib/helpers/service'
import { buildKubeConfig } from '../../lib/helpers/cluster'
import { isWebDemo } from '../../lib/environment'
import { buildSentryIgnoredError } from '../../lib/errors'

const { validate } = createToolset({
  type: 'object',
  required: ['port', 'serviceId', 'state'],
  properties: {
    port: { type: 'integer', minimum: 0, maximum: 65535 },
    serviceId: { type: 'string' },
    state: { type: 'string', enum: Object.values(connectionStates) }
  }
})

const state = {
  // <port>: { port, serviceId, state }
  // state - one of 'connected', 'connecting'
}

const mutations = {
  SET(state, item) {
    const valid = validate(item)
    if (valid) Vue.set(state, item.port, item)
    else throw new Error(JSON.stringify(validate.errors))
  },
  DELETE(state, port) {
    if (!port) throw new Error('port must present')
    Vue.set(state, port)
  }
}

const servers = {}

function killServer(commit, port) {
  let called = false
  const server = servers[port]

  const onClose = () => {
    if (!called) {
      console.info(`Port ${port} have freed`)
      commit('DELETE', port)
      delete servers[port]
      called = true
    }
  }

  if (server) {
    server.kill(onClose())

    // if there wasn't connections, server closed immediately without emitting callback
    // so I have to call callback manually
    if (!server.listening) onClose()
  } else {
    onClose()
  }
}

async function startForward(commit, k8sForward, service, target) {
  const server = net.createServer(function(socket) {
    k8sForward.portForward(target.namespace, target.podName, [target.remotePort], socket, null, socket, 3)
    k8sForward.disconnectOnErr = false
  })

  killable(server)
  return new Promise((resolve) => {
    const serviceString = `Service ${getServiceLabel(service)}(${service.id})`

    server.on('error', (error) => {
      if (server.listening) {
        killServer(commit, target.localPort)
      } else {
        server.kill()
        const prettyError = netServerPrettyError(error)
        console.info(`Error while forwarding ${serviceString}: ${prettyError.message}`)
        resolve({ success: false, error: prettyError })
      }
    })

    server.on('listening', () => {
      servers[target.localPort] = server
      commit('SET', { port: target.localPort, serviceId: service.id, state: connectionStates.CONNECTED })
      console.info(`${serviceString} is forwarding port ${target.localPort} to ${target.podName}:${target.remotePort}`)
      resolve({ success: true })
    })

    server.listen(target.localPort, '127.0.0.1')
  })
}

function prepareK8sToolsWithCluster(cluster) {
  let kubeConfig

  try {
    kubeConfig = buildKubeConfig(cluster.config)
  } catch (error) {
    const message = typeof error.message === 'string'
      ? `\nError message:\n---\n${error.message.substr(0, 1000)}`
      : null
    throw buildSentryIgnoredError(`Cluster config is invalid.${message}`)
  }

  const k8sPortForward = new k8s.PortForward(kubeConfig)
  patchForward(k8sPortForward)

  return { k8sPortForward, kubeConfig }
}

function prepareK8sToolsWithService(rootState, service) {
  const cluster = rootState.Clusters.items[service.clusterId]
  if (!cluster) return { success: false, message: `Cluster(id=${service.clusterId}) doesn't exist` }

  return prepareK8sToolsWithCluster(cluster)
}

async function loadResource(kubeConfig, service) {
  const { workloadType: resourceKind, workloadName: resourceName, namespace } = service

  switch (resourceKind) {
    case resourceKinds.POD:
      return loadPod(kubeConfig, namespace, resourceName)

    case resourceKinds.DEPLOYMENT:
      return loadDeployment(kubeConfig, namespace, resourceName)

    case resourceKinds.SERVICE:
      return loadService(kubeConfig, namespace, resourceName)

    default:
      throw new Error(`Unacceptable resourceKind=${resourceKind}`)
  }
}

async function loadPod(kubeConfig, namespace, podName) {
  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api)

  try {
    return (await coreApi.readNamespacedPod(podName, namespace)).body
  } catch (error) {
    throw k8nApiPrettyError(error, { _object: `Pod "${podName}"` })
  }
}

async function loadDeployment(kubeConfig, namespace, deploymentName) {
  const extensionsApi = kubeConfig.makeApiClient(k8s.ExtensionsV1beta1Api)

  try {
    return (await extensionsApi.readNamespacedDeployment(deploymentName, namespace)).body
  } catch (error) {
    throw k8nApiPrettyError(error, { _object: `Deployment "${deploymentName}"` })
  }
}

async function loadService(kubeConfig, namespace, serviceName) {
  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api)

  try {
    return (await coreApi.readNamespacedService(serviceName, namespace)).body
  } catch (error) {
    throw k8nApiPrettyError(error, { _object: `Service "${serviceName}"` })
  }
}

async function getTarget(kubeConfig, resource, forward) {
  const { name, namespace } = resource.metadata

  switch (resource.kind) {
    case 'Pod':
      return { namespace, ...forward, podName: name }
    case 'Deployment': {
      const podName = await getPodNameFromDeployment(kubeConfig, resource)
      return { namespace, ...forward, podName }
    }
    case 'Service': {
      const podName = await getPodNameFromService(kubeConfig, resource)
      const remotePort = mapServicePort(resource, forward.remotePort)
      return { namespace, localPort: forward.localPort, remotePort, podName }
    }
    default:
      throw new Error(`Unacceptable resource.kind=${resource.kind}`)
  }
}

async function getPodNameFromDeployment(kubeConfig, deployment) {
  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api)

  const { metadata: { namespace, name }, spec: { selector: { matchLabels } } } = deployment
  const matchLabelKey = Object.keys(matchLabels)[0]
  const labelSelector = `${matchLabelKey}=${matchLabels[matchLabelKey]}`

  const { body: podsBody } = await coreApi.listNamespacedPod(namespace, null, null, null, null, labelSelector)
  const podName = podsBody.items.length && podsBody.items[0].metadata.name
  if (!podName) throw buildSentryIgnoredError(`There are no pods in '${name}' deployment.`)

  return podName
}

async function getPodNameFromService(kubeConfig, service) {
  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api)

  const { metadata: { name, namespace }, spec: { selector } } = service
  if (!selector) throw buildSentryIgnoredError(`Service '${name}' does not have a selector.`)

  const { body: pods } = await coreApi.listNamespacedPod(namespace, null, null, null, null, stringifySelector(selector))
  const podName = pods.items.length && pods.items[0].metadata.name
  if (!podName) throw buildSentryIgnoredError(`There are no pods in '${name}' service.`)

  return podName
}

function stringifySelector(selector) {
  const strings = []
  for (const key of Object.keys(selector)) {
    strings.push(`${key}=${selector[key]}`)
  }
  return strings.join(',')
}

function mapServicePort(service, port) {
  for (const servicePort of service.spec.ports) {
    if (servicePort.port === port) return servicePort.targetPort
  }

  throw buildSentryIgnoredError(
    `Service "${
      service.metadata.name
    }" does not have a service port ${port}. Available ports: ${
      service.spec.ports.map(x => x.port).join(', ')
    }`)
}

function createConnectingStates(commit, service) {
  for (const forward of service.forwards) {
    commit('SET', { port: forward.localPort, serviceId: service.id, state: connectionStates.CONNECTING })
  }
}

function clearStates(commit, service) {
  for (const forward of service.forwards) {
    commit('DELETE', forward.localPort)
  }
}

function validateThatRequiredPortsFree(state, service) {
  for (const forward of service.forwards) {
    if (state[forward.localPort]) {
      throw buildSentryIgnoredError(`Port ${forward.localPort} is busy.`)
    }
  }
}

let actions = {
  async createConnection({ commit, state, rootState }, service) {
    try {
      validateThatRequiredPortsFree(state, service)
      createConnectingStates(commit, service)

      const { kubeConfig, k8sPortForward } = prepareK8sToolsWithService(rootState, service)
      const resource = await loadResource(kubeConfig, service)
      const results = await Promise.all(service.forwards.map(async forward => {
        const target = await getTarget(kubeConfig, resource, forward)
        const result = await startForward(commit, k8sPortForward, service, target)
        return { ...result, service, forward, target }
      }))

      const success = !results.find(x => !x.success)
      if (!success) {
        for (const result of results) {
          killServer(commit, result.target.localPort)
        }
      }

      return { success, results }
    } catch (error) {
      // TODO a breadcrumb for originError
      Sentry.captureException(error)
      clearStates(commit, service)
      return { success: false, error }
    }
  },

  deleteConnection({ commit }, service) {
    for (const forward of service.forwards) {
      killServer(commit, forward.localPort)
    }
  }
}

if (isWebDemo) {
  actions = {
    createConnection({ commit }, service) {
      service.forwards.map(forward =>
        commit('SET', { port: forward.localPort, serviceId: service.id, state: connectionStates.CONNECTED })
      )
    },
    deleteConnection({ commit }, service) {
      service.forwards.map(forward =>
        commit('DELETE', forward.localPort)
      )
    }
  }
}

export default {
  persisted: false,
  namespaced: true,
  state,
  mutations,
  actions
}
