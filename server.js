
const config = require('./config');
const mediasoup = require('mediasoup');
console.log(mediasoup.version);
//
// and one "room" ...
//
const roomState = {
  // external
  peers: {},
  activeSpeaker: { producerId: null, volume: null, peerId: null },
  // internal
  transports: {},
  producers: [],
  consumers: []
}

const express = require('express')

var io = require('socket.io')
({
  path: '/webrtc'
})

const app = express()
const port = 8080

// one mediasoup worker and router
//
let worker, router, audioLevelObserver;

// app.get('/', (req, res) => res.send('Hello World!!!!!'))

//https://expressjs.com/en/guide/writing-middleware.html
app.use(express.static(__dirname + '/build'))
app.get('/', (req, res, next) => {
    res.sendFile(__dirname + '/build/index.html')
})

app.use(express.static(__dirname));

const server = app.listen(port, () => console.log(`Example app listening on port ${port}!`))

io.listen(server)

async function _mediasoup() {
  // start mediasoup
  console.log('starting mediasoup');
  // const { worker, router, audioLevelObserver }
  const _mediasoup = await startMediasoup();
  worker = _mediasoup.worker;
  router = _mediasoup.router;
  audioLevelObserver = _mediasoup.audioLevelObserver;
  console.log('starting mediasoup');
}

_mediasoup();

//
// start mediasoup with a single worker and router
//
async function startMediasoup() {
  let worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died (this should never happen)');
    process.exit(1);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  const router = await worker.createRouter({ mediaCodecs });

  // audioLevelObserver for signaling active speaker
  //
  const audioLevelObserver = await router.createAudioLevelObserver({
		interval: 800
	});
  audioLevelObserver.on('volumes', (volumes) => {
    const { producer, volume } = volumes[0];
    log('audio-level volumes event', producer.appData.peerId, volume);
    roomState.activeSpeaker.producerId = producer.id;
    roomState.activeSpeaker.volume = volume;
    roomState.activeSpeaker.peerId = producer.appData.peerId;
  });
  audioLevelObserver.on('silence', () => {
    log('audio-level silence event');
    roomState.activeSpeaker.producerId = null;
    roomState.activeSpeaker.volume = null;
    roomState.activeSpeaker.peerId = null;
  });

  return { worker, router, audioLevelObserver };
}

// https://www.tutorialspoint.com/socket.io/socket.io_namespaces.htm
const peers = io.of('/webrtcPeer')

// keep a reference of all socket connections
let connectedPeers = new Map()

peers.on('connection', socket => {

  // mediasoup::Upon successful connection -------------------------
  const now = Date.now();
  // const peerState = {
  //   joinTs: now,
  //   lastSeenTs: now,
  //   media: {},
  //   consumerLayers: {},
  //   stats: {},
  // }

  // connectedPeers.set(socket.id, {socket, peerState})

  roomState.peers[socket.id] = {
    joinTs: now,
    lastSeenTs: now,
    media: {},
    consumerLayers: {},
    stats: {}
  }

  console.log(socket.id)
  socket.emit('connection-success', { 
    socketID: socket.id,
    routerRtpCapabilities: router.rtpCapabilities,
   });

  socket.on('disconnect', () => {
    console.log('disconnected')
    connectedPeers.delete(socket.id)
  })

  // socket.on('createProducerTransport', async (data, callback) => {
  //   try {
  //     const { transport, params } = await createWebRtcTransport();
  //     producerTransport = transport;
  //     callback(params);
  //   } catch (err) {
  //     console.error(err);
  //     callback({ error: err.message });
  //   }
  // });

  socket.on('create-transport', async data => {
    try {
      let peerId = socket.id;
      let direction = data.direction;
      console.log('create-transport', peerId, direction)

      let transport = await createWebRtcTransport({ peerId, direction });
      roomState.transports[transport.id] = transport;

      let { id, iceParameters, iceCandidates, dtlsParameters } = transport;
      socket.emit('create-transport', {
        direction,
        transportOptions: { id, iceParameters, iceCandidates, dtlsParameters }
      });
    } catch (e) {
      console.error('error in create-transport', e);
      // res.send({ error: e });
    }
  })

  socket.on('connect-transport', async (data, callback) => {
    try {
      let peerId = socket.id,
        { transportId, dtlsParameters } = data,
        transport = roomState.transports[transportId]

      if (!transport){
        console.error(`connect-transport: server-side transport ${transportId} not found`)
        callback({
          connected: false,
          error: `server-side transport ${transportId} not found`
        })
        return
      }

      console.log('connect-transport', peerId, transport.appData)

      await transport.connect({ dtlsParameters })
      callback({
        connected: true
      })
    } catch(e) {
      console.error('error in connect-transport', e)
      callback({error: e.message})
    }
  })

  socket.on('send-track', async (data, callback) => {
    try {
      let peerId = socket.id,
        {
          transportId,
          kind,
          rtpParameters,
          paused=false,
          appData
        } = data,
        transport = roomState.transports[transportId]
      
        if (!transport){
          console.error(`send-track: server-side transport ${transportId} not found`)
          callback({
            connected: false,
            error: `server-side transport ${transportId} not found`
          })
          return
        }
  
        console.log('send-track', peerId, transport.appData)

        let producer = await transport.produce({
          kind, rtpParameters, paused, appData: { ...appData, peerId, transportId }
        })

        // if our associated transport closes, close ourself, too
        producer.on('transportclose', () => {
          console.log('producer\'s transport closed', producer.id);
          closeProducer(producer);
        });

        // monitor audio level of this producer. we call addProducer() here,
        // but we don't ever need to call removeProducer() because the core
        // AudioLevelObserver code automatically removes closed producers
        if (producer.kind === 'audio') {
          audioLevelObserver.addProducer({ producerId: producer.id });
        }

        roomState.producers.push(producer)
        roomState.peers[peerId].media[appData.mediaTag] = {
          paused,
          encodings: rtpParameters.encodings
        }

        callback({
          id: producer.id
        })
    } catch(e) {

    }
  })

  // socket.on('offerOrAnswer', (data) => {
  //   // send to the other peer(s) if any
  //   for (const [socketID, socket] of connectedPeers.entries()) {
  //     // don't send to self
  //     if (socketID !== data.socketID) {
  //       console.log(socketID, data.payload.type)
  //       socket.emit('offerOrAnswer', data.payload)
  //     }
  //   }
  // })

  // socket.on('candidate', (data) => {
  //   // send candidate to the other peer(s) if any
  //   for (const [socketID, socket] of connectedPeers.entries()) {
  //     // don't send to self
  //     if (socketID !== data.socketID) {
  //       console.log(socketID, data.payload)
  //       socket.emit('candidate', data.payload)
  //     }
  //   }
  // })

  // --> sync
  //
  // client polling endpoint. send back our 'peers' data structure and
  // 'activeSpeaker' info
  //
  socket.on('sync', async (data) => {
    let peerId = socket.id;

    try {
      // make sure this peer is connected. if we've disconnected the
      // peer because of a network outage we want the peer to know that
      // happened, when/if it returns
      if (!roomState.peers[peerId]) {
        throw new Error('not connected');
      }

      // update our most-recently-seem timestamp -- we're not stale!
      roomState.peers[peerId].lastSeenTs = Date.now();

      socket.emit('sync', {
        peers: roomState.peers,
        activeSpeaker: roomState.activeSpeaker
      });
    } catch (e) {
      console.error(e.message);
      socket.emit('sync', {
        peers: roomState.peers,
        activeSpeaker: roomState.activeSpeaker
      });
    }
  });

  // --> join-as-new-peer
  //
  // adds the peer to the roomState data structure and creates a
  // transport that the peer will use for receiving media. returns
  // router rtpCapabilities for mediasoup-client device initialization
  //
  socket.on('join-as-new-peer', async (data) => {
    try {
      let peerId = socket.id;
      now = Date.now();

      roomState.peers[peerId] = {
        joinTs: now,
        lastSeenTs: now,
        media: {},
        consumerLayers: {},
        stats: {}
      };

      socket.emit('join-as-new-peer', {
        routerRtpCapabilities: router.rtpCapabilities
      });
    } catch (e) {
      console.error('error in /signaling/join-as-new-peer', e);
      // res.send({ error: e });
    }
  });

  // --> leave
  //
  // removes the peer from the roomState data structure and and closes
  // all associated mediasoup objects
  //
  socket.on('leave', async (data) => {
    try {
      let peerId = socket.id;

      await closePeer(peerId);
      socket.emit('leave', { left: true });
    } catch (e) {
      console.error('error in /signaling/leave', e);
      // res.send({ error: e });
    }
  });

  function closePeer(peerId) {
    console.log('closing peer', peerId);
    for (let [id, transport] of Object.entries(roomState.transports)) {
      if (transport.appData.peerId === peerId) {
        closeTransport(transport);
      }
    }
    delete roomState.peers[peerId];
  }

  async function closeTransport(transport) {
    try {
      console.log('closing transport', transport.id, transport.appData);
  
      // our producer and consumer event handlers will take care of
      // calling closeProducer() and closeConsumer() on all the producers
      // and consumers associated with this transport
      await transport.close();
  
      // so all we need to do, after we call transport.close(), is update
      // our roomState data structure
      delete roomState.transports[transport.id];
    } catch (e) {
      console.log(e);
      // err(e);
    }
  }

  async function closeProducer(producer) {
    console.log('closing producer', producer.id, producer.appData);
    try {
      await producer.close();
  
      // remove this producer from our roomState.producers list
      roomState.producers = roomState.producers
        .filter((p) => p.id !== producer.id);
  
      // remove this track's info from our roomState...mediaTag bookkeeping
      if (roomState.peers[producer.appData.peerId]) {
        delete (roomState.peers[producer.appData.peerId]
                .media[producer.appData.mediaTag]);
      }
    } catch (e) {
      err(e);
    }
  }

  async function closeConsumer(consumer) {
    console.log('closing consumer', consumer.id, consumer.appData);
    await consumer.close();
  
    // remove this consumer from our roomState.consumers list
    roomState.consumers = roomState.consumers.filter((c) => c.id !== consumer.id);
  
    // remove layer info from from our roomState...consumerLayers bookkeeping
    if (roomState.peers[consumer.appData.peerId]) {
      delete roomState.peers[consumer.appData.peerId].consumerLayers[consumer.id];
    }
  }

  // --> create-transport
  //
  // create a mediasoup transport object and send back info needed
  // to create a transport object on the client side
  //
  // socket.on('create-transport', async (data) => {
  //   try {
  //     let peerId = socket.id;
  //     let direction = data.direction;

  //     let transport = await createWebRtcTransport({ peerId, direction });
  //     roomState.transports[transport.id] = transport;

  //     let { id, iceParameters, iceCandidates, dtlsParameters } = transport;
  //     socket.emit('create-transport', {
  //       transportOptions: { id, iceParameters, iceCandidates, dtlsParameters }
  //     });
  //   } catch (e) {
  //     console.error('error in /signaling/create-transport', e);
  //     // res.send({ error: e });
  //   }
  // });

  createWebRtcTransport = async ({ peerId, direction }) => {
    const {
      listenIps,
      initialAvailableOutgoingBitrate
    } = config.mediasoup.webRtcTransport;
  
    const transport = await router.createWebRtcTransport({
      listenIps: listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
      appData: { peerId, clientDirection: direction }
    });
  
    // console.log(transport)
    return transport;
  }

  // --> connect-transport
  //
  // called from inside a client's `transport.on('connect')` event
  // handler.
  //
  // socket.on('connect-transport', async (data) => {
  //   try {
  //     let { peerId, transportId, dtlsParameters } = data,
  //     transport = roomState.transports[transportId];

  //     if (!transport) {
  //       console.log(`connect-transport: server-side transport ${transportId} not found`);
  //       socket.emit('connect-transport', { error: `server-side transport ${transportId} not found` });
  //       return;
  //     }

  //     console.log('connect-transport', peerId, transport.appData);

  //     await transport.connect({ dtlsParameters });
  //     socket.emit('connect-transport', { connected: true });
  //   } catch (e) {
  //     console.error('error in /signaling/connect-transport', e);
  //     // res.send({ error: e });
  //   }
  // });

  // --> close-transport
  //
  // called by a client that wants to close a single transport (for
  // example, a client that is no longer sending any media).
  //
  // socket.on('close-transport', async (data) => {  
  //   try {
  //     let { peerId, transportId } = data,
  //         transport = roomState.transports[transportId];

  //     if (!transport) {
  //       err(`close-transport: server-side transport ${transportId} not found`);
  //       socket.emit('close-transport', { error: `server-side transport ${transportId} not found` });
  //       return;
  //     }

  //     log('close-transport', peerId, transport.appData);

  //     await closeTransport(transport);
  //     socket.emit('close-transport', { closed: true });
  //   } catch (e) {
  //     console.error('error in /signaling/close-transport', e);
  //     // res.send({ error: e.message });
  //   }
  // });

  // --> /signaling/close-producer
  //
  // called by a client that is no longer sending a specific track
  //
  // socket.on('close-producer', async (data) => {
  //   try {
  //     let { peerId, producerId } = req.body,
  //         producer = roomState.producers.find((p) => p.id === producerId);

  //     if (!producer) {
  //       err(`close-producer: server-side producer ${producerId} not found`);
  //       socket.emit('close-producer', { error: `server-side producer ${producerId} not found` });
  //       return;
  //     }

  //     log('close-producer', peerId, producer.appData);

  //     await closeProducer(producer);
  //     socket.emit('close-producer', { closed: true });
  //   } catch (e) {
  //     console.error(e);
  //     // res.send({ error: e.message });
  //   }
  // });


  // --> send-track
  //
  // called from inside a client's `transport.on('produce')` event handler.
  //
  // socket.on('send-track', async (data) => {
  //   try {
  //     let { peerId, transportId, kind, rtpParameters,
  //           paused=false, appData } = data,
  //         transport = roomState.transports[transportId];
  
  //     if (!transport) {
  //       console.log(`send-track: server-side transport ${transportId} not found`);
  //       socket.emit('send-track', { error: `server-side transport ${transportId} not found`});
  //       return;
  //     }
  
  //     let producer = await transport.produce({
  //       kind,
  //       rtpParameters,
  //       paused,
  //       appData: { ...appData, peerId, transportId }
  //     });
  
  //     // if our associated transport closes, close ourself, too
  //     producer.on('transportclose', () => {
  //       console.log('producer\'s transport closed', producer.id);
  //       closeProducer(producer);
  //     });
  
  //     // monitor audio level of this producer. we call addProducer() here,
  //     // but we don't ever need to call removeProducer() because the core
  //     // AudioLevelObserver code automatically removes closed producers
  //     if (producer.kind === 'audio') {
  //       audioLevelObserver.addProducer({ producerId: producer.id });
  //     }
  
  //     roomState.producers.push(producer);
  //     roomState.peers[peerId].media[appData.mediaTag] = {
  //       paused,
  //       encodings: rtpParameters.encodings
  //     };
  
  //     socket.emit('send-track', { id: producer.id });
  //   } catch (e) {
  //   }
  // });

  // --> recv-track
  //
  // create a mediasoup consumer object, hook it up to a producer here
  // on the server side, and send back info needed to create a consumer
  // object on the client side. always start consumers paused. client
  // will request media to resume when the connection completes
  //
  socket.on('recv-track', async (data, callback) => {
    try {
      let peerId = socket.id,
        { mediaPeerId, mediaTag, rtpCapabilities } = data;
  
      let producer = roomState.producers.find(
        (p) => p.appData.mediaTag === mediaTag &&
               p.appData.peerId !== mediaPeerId
      );
  
      if (!producer) {
        let msg = 'server-side producer for ' +
                    `${mediaPeerId}:${mediaTag} not found`;
        console.log('recv-track: ' + msg);
        socket.emit('recv-track', { error: msg });
        return;
      }
  
      if (!router.canConsume({ producerId: producer.id,
                               rtpCapabilities })) {
        let msg = `client cannot consume ${mediaPeerId}:${mediaTag}`;
        console.log(`recv-track: ${peerId} ${msg}`);
        socket.emit('recv-track', { error: msg });
        return;
      }
  
      let transport = Object.values(roomState.transports).find((t) =>
        t.appData.peerId === peerId && t.appData.clientDirection === 'recv'
      );
  
      if (!transport) {
        let msg = `server-side recv transport for ${peerId} not found`;
        console.log('recv-track: ' + msg);
        socket.emit('recv-track', { error: msg });
        return;
      }
  
      let consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true, // see note above about always starting paused
        appData: { peerId, mediaPeerId, mediaTag }
      });
  
      // need both 'transportclose' and 'producerclose' event handlers,
      // to make sure we close and clean up consumers in all
      // circumstances
      consumer.on('transportclose', () => {
        console.log(`consumer's transport closed`, consumer.id);
        closeConsumer(consumer);
      });
      consumer.on('producerclose', () => {
        console.log(`consumer's producer closed`, consumer.id);
        closeConsumer(consumer);
      });
  
      // stick this consumer in our list of consumers to keep track of,
      // and create a data structure to track the client-relevant state
      // of this consumer
      roomState.consumers.push(consumer);
      roomState.peers[peerId].consumerLayers[consumer.id] = {
        currentLayer: null,
        clientSelectedLayer: null
      };
  
      // update above data structure when layer changes.
      consumer.on('layerschange', (layers) => {
        console.log(`consumer layerschange ${mediaPeerId}->${peerId}`, mediaTag, layers);
        if (roomState.peers[peerId] &&
            roomState.peers[peerId].consumerLayers[consumer.id]) {
          roomState.peers[peerId].consumerLayers[consumer.id]
            .currentLayer = layers && layers.spatialLayer;
        }
      });
  
      callback({
        producerId: producer.id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused
      });
    } catch (e) {
      console.error('error in /signaling/recv-track', e);
      // res.send ({ error: e });
    }
  });

  // --> pause-consumer
  //
  // called to pause receiving a track for a specific client
  //
  // socket.on('pause-consumer', async (data) => {
  //   try {
  //     let { peerId, consumerId } = data,
  //         consumer = roomState.consumers.find((c) => c.id === consumerId);
  
  //     if (!consumer) {
  //       console.error(`pause-consumer: server-side consumer ${consumerId} not found`);
  //       socket.emit('pause-consumer', { error: `server-side producer ${consumerId} not found` });
  //       return;
  //     }
  
  //     console.log('pause-consumer', consumer.appData);
  
  //     await consumer.pause();
  
  //     socket.emit('pause-consumer', { paused: true});
  //   } catch (e) {
  //     console.error('error in /signaling/pause-consumer', e);
  //     // res.send({ error: e });
  //   }
  // });

  // --> resume-consumer
  //
  // called to resume receiving a track for a specific client
  //
  socket.on('resume-consumer', async (data, callback) => {
    try {
      let peerId = socket.id,
        { consumerId } = data,
          consumer = roomState.consumers.find((c) => c.id === consumerId);
  
      if (!consumer) {
        console.error(`pause-consumer: server-side consumer ${consumerId} not found`);
        callback({ error: `server-side consumer ${consumerId} not found` });
        return;
      }
  
      console.log('resume-consumer', consumer.appData);
  
      await consumer.resume();
  
      callback({ resumed: true });
    } catch (e) {
      console.error('error in /signaling/resume-consumer', e);
      callback({ error: e });
    }
  });

  // --> close-consumer
  //
  // called to stop receiving a track for a specific client. close and
  // clean up consumer object
  //
  socket.on('close-consumer', async (data) => {
    try {
    let { peerId, consumerId } = data,
        consumer = roomState.consumers.find((c) => c.id === consumerId);
  
      if (!consumer) {
        console.error(`close-consumer: server-side consumer ${consumerId} not found`);
        socket.emit('close-consumer', { error: `server-side consumer ${consumerId} not found` });
        return;
      }
  
      await closeConsumer(consumer);
  
      socket.emit('close-consumer', { closed: true });
    } catch (e) {
      console.error('error in /signaling/close-consumer', e);
      // res.send({ error: e });
    }
  });
  
  // --> consumer-set-layers
  //
  // called to set the largest spatial layer that a specific client
  // wants to receive
  //
  // socket.emit('consumer-set-layers', async (data) => {
  //   try {
  //     let { peerId, consumerId, spatialLayer } = data,
  //         consumer = roomState.consumers.find((c) => c.id === consumerId);
  
  //     if (!consumer) {
  //       console.error(`consumer-set-layers: server-side consumer ${consumerId} not found`);
  //       socket.emit('consumer-set-layers', { error: `server-side consumer ${consumerId} not found` });
  //       return;
  //     }
  
  //     log('consumer-set-layers', spatialLayer, consumer.appData);
  
  //     await consumer.setPreferredLayers({ spatialLayer });
  
  //     socket.emit('consumer-set-layers', { layersSet: true });
  //   } catch (e) {
  //     console.error('error in /signaling/consumer-set-layers', e);
  //     socket.emit('consumer-set-layers', { error: e });
  //   }
  // });
  
  // --> pause-producer
  //
  // called to stop sending a track from a specific client
  //
  // socket.on('pause-producer', async (req, res) => {
  //   try {
  //     let { peerId, producerId } = req.body,
  //         producer = roomState.producers.find((p) => p.id === producerId);
  
  //     if (!producer) {
  //       console.error(`pause-producer: server-side producer ${producerId} not found`);
  //       socket.emit('pause-producer', { error: `server-side producer ${producerId} not found` });
  //       return;
  //     }
  
  //     log('pause-producer', producer.appData);
  
  //     await producer.pause();
  
  //     roomState.peers[peerId].media[producer.appData.mediaTag].paused = true;
  
  //     socket.emit('pause-producer', { paused: true });
  //   } catch (e) {
  //     console.error('error in /signaling/pause-producer', e);
  //     socket.emit('pause-producer', { error: e });
  //   }
  // });
  
  // --> resume-producer
  //
  // called to resume sending a track from a specific client
  //
  // socket.on('resume-producer', async (data) => {
  //   try {
  //     let { peerId, producerId } = data,
  //         producer = roomState.producers.find((p) => p.id === producerId);
  
  //     if (!producer) {
  //       console.error(`resume-producer: server-side producer ${producerId} not found`);
  //       socket.emit('resume-producer', { error: `server-side producer ${producerId} not found` });
  //       return;
  //     }
  
  //     log('resume-producer', producer.appData);
  
  //     await producer.resume();
  
  //     roomState.peers[peerId].media[producer.appData.mediaTag].paused = false;
  
  //     socket.emit('resume-producer', { resumed: true });
  //   } catch (e) {
  //     console.error('error in resume-producer', e);
  //     socket.emit('resume-producer', { error: e });
  //   }
  // });
})



//
// stats
//

async function updatePeerStats() {
  for (let producer of roomState.producers) {
    if (producer.kind !== 'video') {
      continue;
    }
    try {
      let stats = await producer.getStats(),
          peerId = producer.appData.peerId;
      roomState.peers[peerId].stats[producer.id] = stats.map((s) => ({
        bitrate: s.bitrate,
        fractionLost: s.fractionLost,
        jitter: s.jitter,
        score: s.score,
        rid: s.rid
      }));
    } catch (e) {
      console.warn('error while updating producer stats', e);
    }
  }

  for (let consumer of roomState.consumers) {
    try {
      let stats = (await consumer.getStats())
                    .find((s) => s.type === 'outbound-rtp'),
          peerId = consumer.appData.peerId;
      if (!stats || !roomState.peers[peerId]) {
        continue;
      }
      roomState.peers[peerId].stats[consumer.id] = {
        bitrate: stats.bitrate,
        fractionLost: stats.fractionLost,
        score: stats.score
      }
    } catch (e) {
      console.warn('error while updating consumer stats', e);
    }
  }
}