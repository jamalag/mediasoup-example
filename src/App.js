import React, { Component } from 'react';

import * as mediasoup from 'mediasoup-client';

import io from 'socket.io-client'

// const socketPromise = require('./lib/socket.io-promise').promise;
// const socketPromise = (socket) => {
//   return function request(type, data = {}) {
//     return new Promise((resolve) => {
//       socket.emit(type, data, resolve);
//     });
//   }
// };

class App extends Component {
  constructor(props) {
    super(props)

    // https://reactjs.org/docs/refs-and-the-dom.html
    this.localVideoref = React.createRef()
    this.remoteVideoref = React.createRef()

    this.socket = null
    this.candidates = []

    this.device = null
    this.sendTransport = null
  }

  componentDidMount = () => {

    try {
      this.device = new mediasoup.Device()
      console.log(this.device)
    } catch(e) {
      if (e.name === 'UnsupportedError') {
        console.error('browser not supported for video calls')
        return
      } else {
        console.error(e)
      }
    }

    this.socket = io(
      '/webrtcPeer',
      {
        path: '/webrtc',
        query: {}
      }
    )

    // this.socket.request = socketPromise(this.socket);
    this.socket.request = (type, data = {}) => {
      return new Promise((resolve) => {
        this.socket.emit(type, data, resolve);
      });
    }

    this.socket.on('connection-success', data => {
      console.log(data.socketID, data.routerRtpCapabilities)

      const loadDevice = async () => {
        if (!this.device.loaded) {
          await this.device.load({ routerRtpCapabilities: data.routerRtpCapabilities })
          console.log('Device Loaded', this.device.loaded)
        }
      }

      console.log('Device Loaded', this.device.loaded)
      loadDevice();
    })

    this.socket.on('create-transport', async (data) => {

      // ask the server to create a server-side transport object and send
      // back the info we need to create a client-side transport
      let transport,
        { direction ,transportOptions } = data
      
      console.log('transport options', transportOptions)

      if (direction === 'recv') {
        transport = await this.device.createRecvTransport(transportOptions)
        this.recvTransport = transport
      } else if (direction === 'send') {
        console.log('Creating Send Transport ...')
        transport = await this.device.createSendTransport(transportOptions)
        this.sendTransport = transport
        
        console.log('transport-', transport)
      } else {
        console.log(`bad transport 'direction': ${direction}`)
      }

      // mediasoup-client will emit a connect event when media needs to
      // start flowing for the first time. send dtlsParameters to the
      // server, then call callback() on success or errback() on failure.
      transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        console.log('transport connect event', direction)
        this.socket.request('connect-transport', {
          transportId: transportOptions.id,
          dtlsParameters
        })
        .then(callback)
        .then(errback)
      })

      if (direction === 'send') {
        // sending transports will emit a produce event when a new track
        // needs to be set up to start sending.
        // producer's appData is passed as a parameter
        transport.on('produce', async ({
          kind, rtpParameters, appData
        }, callback, errback) => {
          console.log('transport produce event', appData.mediaTag)

          // check if paused

          // send to server what it needs to know from client to set up 
          // server-side producer objects, and get back a producer.id
          this.socket.request('send-track', {
            transportId: transportOptions.id,
            kind,
            rtpParameters,
            paused: false, //paused,
            appData,
          })
          .then(({id}) => {
            console.log('send-track: did we get ID?', id)
            callback({id})
          })
          .then(errback)
        })
      }


    })

    // this.socket.on('offerOrAnswer', (sdp) => {
    //   this.textref.value = JSON.stringify(sdp)

    //   // set sdp as remote description
    //   this.pc.setRemoteDescription(new RTCSessionDescription(sdp))
    // })

    // this.socket.on('candidate', (candidate) => {
    //   // console.log('From Peer... ', JSON.stringify(candidate))
    //   // this.candidates = [...this.candidates, candidate]
    //   this.pc.addIceCandidate(new RTCIceCandidate(candidate))
    // })

    // const pc_config = null

    // const pc_config = {
    //   "iceServers": [
    //     // {
    //     //   urls: 'stun:[STUN_IP]:[PORT]',
    //     //   'credentials': '[YOR CREDENTIALS]',
    //     //   'username': '[USERNAME]'
    //     // },
    //     {
    //       urls : 'stun:stun.l.google.com:19302'
    //     }
    //   ]
    // }

    // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection
    // create an instance of RTCPeerConnection
    // this.pc = new RTCPeerConnection(pc_config)

    // triggered when a new candidate is returned
    // this.pc.onicecandidate = (e) => {
    //   // send the candidates to the remote peer
    //   // see addCandidate below to be triggered on the remote peer
    //   if (e.candidate) {
    //     // console.log(JSON.stringify(e.candidate))
    //     this.sendToPeer('candidate', e.candidate)
    //   }
    // }

    // triggered when there is a change in connection state
    // this.pc.oniceconnectionstatechange = (e) => {
    //   console.log(e)
    // }

    // triggered when a stream is added to pc, see below - this.pc.addStream(stream)
    // this.pc.onaddstream = (e) => {
    //   this.remoteVideoref.current.srcObject = e.stream
    // }

    // called when getUserMedia() successfully returns - see below
    // getUserMedia() returns a MediaStream object (https://developer.mozilla.org/en-US/docs/Web/API/MediaStream)
    const success = (stream) => {
      window.localStream = stream
      this.localVideoref.current.srcObject = stream
      this.pc.addStream(stream)
    }

    // called when getUserMedia() fails - see below
    const failure = (e) => {
      console.log('getUserMedia Error: ', e)
    }

    // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
    // see the above link for more constraint options
    const constraints = {
      audio: true,
      video: true,
      // video: {
      //   width: 1280,
      //   height: 720
      // },
      // video: {
      //   width: { min: 1280 },
      // }
    }

    // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
    navigator.mediaDevices.getUserMedia(constraints)
      .then(success)
      .catch(failure)
  }

  sendToPeer = (messageType, payload) => {
    this.socket.emit(messageType, {
      socketID: this.socket.id,
      payload
    })
  }

  /* ACTION METHODS FROM THE BUTTONS ON SCREEN */

  // createOffer = () => {
  //   console.log('Offer')

  //   // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createOffer
  //   // initiates the creation of SDP
  //   this.pc.createOffer({ offerToReceiveVideo: 1 })
  //     .then(sdp => {
  //       // console.log(JSON.stringify(sdp))

  //       // set offer sdp as local description
  //       this.pc.setLocalDescription(sdp)

  //       this.sendToPeer('offerOrAnswer', sdp)
  //   })
  // }

  // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createAnswer
  // creates an SDP answer to an offer received from remote peer
  // createAnswer = () => {
  //   console.log('Answer')
  //   this.pc.createAnswer({ offerToReceiveVideo: 1 })
  //     .then(sdp => {
  //       // console.log(JSON.stringify(sdp))

  //       // set answer sdp as local description
  //       this.pc.setLocalDescription(sdp)

  //       this.sendToPeer('offerOrAnswer', sdp)
  //   })
  // }

  // setRemoteDescription = () => {
  //   // retrieve and parse the SDP copied from the remote peer
  //   const desc = JSON.parse(this.textref.value)

  //   // set sdp as remote description
  //   this.pc.setRemoteDescription(new RTCSessionDescription(desc))
  // }

  // addCandidate = () => {
  //   // retrieve and parse the Candidate copied from the remote peer
  //   // const candidate = JSON.parse(this.textref.value)
  //   // console.log('Adding candidate:', candidate)

  //   // add the candidate to the peer connection
  //   // this.pc.addIceCandidate(new RTCIceCandidate(candidate))

  //   this.candidates.forEach(candidate => {
  //     console.log(JSON.stringify(candidate))
  //     this.pc.addIceCandidate(new RTCIceCandidate(candidate))
  //   });
  // }

  createProducer = async () => {
    this.socket.emit('create-transport', {
      direction: 'send',
    }) 
  }

  createConsumer = async () => {
    this.socket.emit('create-transport', {
      direction: 'recv',
    }) 
  }

  sendStream = async () => {
    // make sure we have joined the room and started the camera.
    
    // start sending video. the transport logic will initiate a
    // signaling conversation with the server to set up an outbound rtp
    // stream for the camera video track. our createTransport() function
    // includes logic to tell the server to start the stream in a paused
    // state, if the checkbox in our UI is unchecked. so as soon as we
    // have a client-side camVideoProducer object, we need to set it to
    // paused as appropriate, too.
    console.log('video tracks', window.localStream.getVideoTracks()[0])
    console.log('video tracks', window.localStream.getAudioTracks()[0])
    console.log('video tracks', this.sendTransport)
    this.videoProducer = await this.sendTransport.produce({
      track: window.localStream.getVideoTracks()[0],
      encodings: [
        { maxBitrate: 96000, scaleResolutionDownBy: 4 },
        { maxBitrate: 680000, scaleResolutionDownBy: 1 },
      ],
      appData: {
        mediaTag: 'cam-video'
      }
    })
    // check if paused at start
    //await videoProducer.pause()

    this.audioProducer = await this.sendTransport.produce({
      track: window.localStream.getAudioTracks()[0],
      appData: { mediaTag: 'cam-audio' }
    })
    // check if paused at start
    //await audioProducer.pause()
  }

  recvStream = async () => {
    // if we already have a consumer no need for this

    // else ...
    // ask server to create server-side consumer object and send back
    // info needed to create a client-side consumer
    let consumerParameters = await this.socket.request('recv-track', {
      mediaTag : 'cam-video',
      mediaPeerId: this.socket.id,
      rtpCapabilities: this.device.rtpCapabilities
    })
    // .then(({msg}) => console.log(msg))
    console.log('consumer params', consumerParameters)
    let consumer = await this.recvTransport.consume({
      ...consumerParameters,
      appData: { peerId: '', mediaTag: 'cam-video' }
    })
    console.log('consumer id', consumer.id)

    // server-side consumer starts in paused state, we call resume request
    // once connected
    while (this.recvTransport.connectionState !== 'connected') {
      console.log('state', this.recvTransport.connectionState)
      await this.sleep(100)
    }
    console.log('state', this.recvTransport.connectionState)

    const success = await this.socket.request('resume-consumer', { consumerId: consumer.id})
    console.log(success)

    console.log('track', consumer.track.clone())
    this.remoteVideoref.current.srcObject = new MediaStream([ consumer.track.clone() ])
  }

  //
  // promisified sleep
  //

  sleep = async (ms) => {
    return new Promise((r) => setTimeout(() => r(), ms));
  }

  render() {

    return (
      <div>
        <video
          style={{
            width: 240,
            height: 240,
            margin: 5,
            backgroundColor: 'black'
          }}
          ref={ this.localVideoref }
          autoPlay>
        </video>
        <video
          style={{
            width: 240,
            height: 240,
            margin: 5,
            backgroundColor: 'black'
          }}
          ref={ this.remoteVideoref }
          autoPlay>
        </video>
        {/* <br />

        <button onClick={this.createOffer}>Offer</button>
        <button onClick={this.createAnswer}>Answer</button>

        <br />
        <textarea style={{ width: 450, height:40 }} ref={ref => { this.textref = ref }} /> */}

        <br />
        <button onClick={this.createProducer}>Create Producer</button>
        <button onClick={this.sendStream}>Send Stream</button>
        <button onClick={this.createConsumer}>Create Consumer</button>
        <button onClick={this.recvStream}>Receive Stream(s)</button>
      </div>
    )
  }
}

export default App;