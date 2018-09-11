#!/usr/bin/env node

const msgpack = require('msgpack-lite')

const { Node } = require('../../lib/index')

async function _main () {
  if (process.argv.length < 3 || process.argv.length > 4) {
    throw new Error('expecting ipc / node name, and optional connect addr')
  }

  const ipc = 'ipc://./' + process.argv[2] + '.ipc.sock'

  console.log('ipc socket: ' + ipc)

  const node = new Node()
  console.log('initialize node')
  await node.init(ipc, '/ip4/0.0.0.0/tcp/0')

  node.on('message', opt => {
    opt.resolve()
    node.ipcSendMessage(msgpack.encode({
      type: 'message',
      data: {
        from: opt.data.from.substr(0, 8),
        msg: opt.data.msg
      }
    }))
  })

  node.on('ipcMessage', opt => {
    try {
      const msg = msgpack.decode(opt.data)
      switch (msg.type) {
        case 'getName':
          opt.resolve(msgpack.encode(node.getId().substr(0, 8)))
          break
        case 'message':
          for (let peer of node.listPeers()) {
            node.send(peer, msgpack.encode(msg.data)).then(() => {}, () => {})
          }
          opt.resolve(Buffer.alloc(0))
          break
        default:
          opt.reject(new Error('unhandled message: ' + msg.type))
          break
      }
    } catch (e) {
      opt.reject(e)
    }
  })

  if (process.argv.length > 3) {
    await node.connect(process.argv[3])
  }

  for (let e of node.getAddrs()) {
    console.log(e)
  }

  _log('start')
  const handleTerm = () => {
    _log('end')
    node.close()
    process.exit(0)
  }

  process.on('SIGINT', handleTerm)
  process.on('SIGTERM', handleTerm)
  process.on('exit', handleTerm)
  process.on('uncaughtException', e => {
    console.error(e.stack || e.toString())
    handleTerm()
  })

  setInterval(() => {}, 1000)
}

function _log (...args) {
  // args.unshift((new Date()).toISOString())
  // fs.appendFileSync('_clog.txt', JSON.stringify(args) + '\n')
}

_main().then(() => {}, (err) => {
  console.error(err)
  process.exit(1)
})
