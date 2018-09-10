#!/usr/bin/env node
'use strict'

const EventEmitter = require('events')

const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const pull = require('pull-stream/pull')
const IpcServer = require('node-p2p-ipc').Server

const { Bundle } = require('./libp2p-bundle')
const { $p } = require('./util')

class Server extends EventEmitter {
  /**
   */
  async init (ipcBind, p2pBind) {
    await this._initP2pSocket(Array.isArray(p2pBind) ? p2pBind : [p2pBind])
    await this._initIpcSocket(Array.isArray(ipcBind) ? ipcBind : [ipcBind])
  }

  /**
   */
  async close () {
    this.removeAllListeners()
    this.setMaxListeners(0)
    if (this.ipc) {
      this.ipc.close()
      this.ipc = null
    }
  }

  /**
   */
  async connect (endpoint) {
    console.log('attempting to dial:', process.argv[2])
    await $p(this.p2p.dial.bind(this.p2p, process.argv[2]))
    console.log('dial complete')
  }

  /**
   */
  getId () {
    return this.p2p.peerInfo.id.toB58String()
  }

  // -- private -- //

  /**
   */
  async _p2pSend (toAddress, data) {
    const pr = this.p2p.peerRouting
    console.log('finding peer: ' + JSON.stringify(toAddress))
    const peer = await $p(pr.findPeer.bind(pr, PeerId.createFromB58String(toAddress)))
    console.log('found peer: ' + peer.id.toB58String())
    const result = await new Promise(async (resolve, reject) => {
      const conn = await $p(this.p2p.dialProtocol.bind(this.p2p, peer, '/pajama/0.0.1'))
      pull(makeGen(data), conn)
      pull(conn, makeSink((data) => {
        resolve(data)
      }))
    })
    return result
  }

  /**
   */
  async _initP2pSocket (p2pBind) {
    const me = await $p(PeerInfo.create)
    const id = me.id.toB58String()

    for (let bind of p2pBind) {
      me.multiaddrs.add(bind)
    }

    const node = this.p2p = new Bundle({
      peerInfo: me
    })

    node.handle('/pajama/0.0.1', (protocol, conn) => {
      pull(conn, makeSink((data) => {
        pull(makeGen('echo: ' + data), conn)
      }))
    })

    // this doesn't seem to ever be emitted
    //node.on('peer:discovery', (peer) => {
    //  console.log('DISCOVERY', peer.id.toB58String())
    //})

    node.on('peer:connect', async (peer) => {
      console.log('new peer', peer.id.toB58String())

      setTimeout(async () => {
        console.log(' -- @@ -- requesting: "hello test"')
        const result = await this._p2pSend(peer.id.toB58String(), 'hello test')
        console.log(' -- @@ -- got response: "' + result + '"')
      }, 1000)
    })

    node.on('peer:disconnect', (peer) => {
      console.log('lost peer', peer.id.toB58String())
    })

    await $p(node.start.bind(node))

    /// ACK! HACK! is there a better way to do this??
    node._dht.randomWalk.start(1, 5000, 10000)

    this.emit(
      'listening',
      node.peerInfo.multiaddrs.toArray().map((a) => a.toString()))
  }

  /**
   */
  async _initIpcSocket (ipcBind) {
    /*
    this.ipc = new IpcServer(ipcBind)

    this.ipc.on('clientAdd', (id) => {
      console.log('adding ipc client ' + id)
    })

    this.ipc.on('clientRemove', (id) => {
      console.log('prune ipc client ' + id)
    })

    this.ipc.on('send', (msg) => {

    })
    */
  }
}

/**
 */
function makeGen(data) {
  let sent = false
  return (end, cb) => {
    if (end) return cb(end)
    if (sent) {
      cb(true)
    } else {
      sent = true
      cb(null, data)
    }
  }
}

/**
 */
function makeSink (cb) {
  return (read) => {
    let data = ''
    const next = (end, chunk) => {
      if (end === true) {
        cb(data)
        return
      }
      if (end) throw end
      data += chunk.toString('utf8')
      setImmediate(() => {
        read(null, next)
      })
    }
    read(null, next)
  }
}

/**
 */
async function _main () {
  const srv = new Server();

  srv.on('listening', (addrs) => {
    console.log('## listening, bound to: ##')
    for (let addr of addrs) {
      console.log(addr)
    }
  })

  process.on('SIGINT', async () => {
    await srv.close()
    console.log('## cleanup complete ##')
    process.exit(0)
  })

  console.log('## starting up ##')
  await srv.init('ipc://test-socket.sock', '/ip4/0.0.0.0/tcp/0')
  console.log('## got id: ##')
  console.log(srv.getId())

  if (process.argv.length === 3) {
    await srv.connect(process.argv[2])
  }
}

_main().then(() => {}, (err) => {
  console.error(err)
  process.exit(1)
})
