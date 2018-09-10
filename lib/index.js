#!/usr/bin/env node
'use strict'

const EventEmitter = require('events')

const msgpack = require('msgpack-lite')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const pull = require('pull-stream/pull')
const { IpcServer } = require('node-p2p-ipc')

const { P2pBundle } = require('./libp2p-bundle')
const { $p } = require('./util')

function _sleep (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms)
  })
}

class Node extends EventEmitter {
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
    if (this._ipc) {
      this._ipc.destroy()
      this._ipc = null
    }
    if (this._p2p) {
      /// ACK! HACK! is there a better way to do this??
      this._p2p._dht.randomWalk.stop()

      await $p(this._p2p.stop.bind(this._p2p))
      this._p2p = null
    }
  }

  /**
   */
  async connect (endpoint) {
    console.log('attempting to dial:', endpoint)
    await $p(this._p2p.dial.bind(this._p2p, endpoint))
    console.log('dial complete')
  }

  /**
   */
  getId () {
    return this._p2p.peerInfo.id.toB58String()
  }

  /**
   */
  getAddrs () {
    return this._p2p.peerInfo.multiaddrs.toArray().map(
      (a) => a.toString())
  }

  /**
   */
  listPeers () {
    return this._p2p.peerBook.getAllArray().map(p => {
      return p.id.toB58String()
    })
  }

  /**
   */
  send (toAddress, data) {
    // this needed??
    return this._p2pSend(toAddress, data)
  }

  // -- private -- //

  /**
   */
  async _p2pSend (toAddress, data) {
    const pr = this._p2p.peerRouting
    console.log('finding peer: ' + JSON.stringify(toAddress))
    const start = Date.now();
    let peer = null
    while (Date.now() - start < 5000) {
      try {
        peer = await $p(pr.findPeer.bind(
          pr, PeerId.createFromB58String(toAddress)))
      } catch (e) {
        peer = null
        await _sleep(100)
      }
    }
    if (!peer) {
      throw new Error('could not find peer')
    }
    console.log('found peer: ' + peer.id.toB58String())
    const result = await new Promise(async (resolve, reject) => {
      const conn = await $p(this._p2p.dialProtocol.bind(this._p2p, peer, '/holomsg/0.0.1'))
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

    const node = this._p2p = new P2pBundle({
      peerInfo: me
    })

    node.handle('/holomsg/0.0.1', (protocol, conn) => {
      pull(conn, makeSink(async (data) => {
        const query = msgpack.decode(data)
        switch (query.type) {
          case 'ping':
            pull(makeGen(msgpack.encode({
              type: 'pong',
              originTime: query.now,
              srvTime: Date.now()
            })), conn)
            break
          default:
            //throw new Error('unexpected holomsg type: ' + JSON.stringify(query))
            const res = await new Promise((resolve, reject) => {
              this.emit('message', {
                data: query,
                resolve,
                reject
              })
            })
            pull(makeGen(data), conn)
        }
      }))
    })

    // this doesn't seem to ever be emitted
    //node.on('peer:discovery', (peer) => {
    //  console.log('DISCOVERY', peer.id.toB58String())
    //})

    node.on('peer:connect', async (peer) => {
      console.log('new peer', peer.id.toB58String())

      const result = msgpack.decode(await this._p2pSend(
        peer.id.toB58String(), msgpack.encode({
          type: 'ping',
          now: Date.now()
        })))
      console.log(' -- ping round trip -- ' + (
        Date.now() - result.originTime) + ' ms')
    })

    node.on('peer:disconnect', (peer) => {
      console.log('lost peer', peer.id.toB58String())
    })

    await $p(node.start.bind(node))

    /// ACK! HACK! is there a better way to do this??
    node._dht.randomWalk.start(1, 5000, 10000)

    this.emit(
      'listening',
      this.getAddrs())
  }

  /**
   */
  async _initIpcSocket (ipcBind) {
    this._ipc = new IpcServer()
    this._ipc.on('call', opt => {
      this.emit('ipcMessage', {
        data: opt.data,
        resolve: opt.resolve,
        reject: opt.reject
      })
    })
    await this._ipc.bind(ipcBind)
  }

  /**
   */
  ipcSendMessage (data) {
    return this._ipc.call(data)
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
    let data = Buffer.alloc(0)
    const next = (end, chunk) => {
      if (end === true) {
        cb(data)
        return
      }
      if (end) throw end
      data = Buffer.concat([data, chunk])
      setImmediate(() => {
        read(null, next)
      })
    }
    read(null, next)
  }
}

exports.Node = Node

/*
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
*/
