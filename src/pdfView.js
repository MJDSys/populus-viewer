import { h, createRef, Fragment, Component } from 'preact';
import Router from 'preact-router';
import './styles/pdfView.css'
import './styles/content-container.css'
import * as Matrix from "matrix-js-sdk"
import * as Layout from "./layout.js"
import AnnotationLayer from "./annotation.js"
import Chat from "./chat.js"
import AnnotationListing from "./annotationListing.js"
import SearchResults from "./searchResults.js"
import PdfCanvas from "./pdfCanvas.js"
import History from './history.js'
import Client from './client.js'
import Navbar from "./navbar.js"
import { eventVersion, spaceChild, spaceParent, lastViewed } from "./constants.js"
import { calculateUnread } from './utils/unread.js'
import SyncIndicator from './syncIndicator.js'
import Modal from "./modal.js"
import Toast from "./toast.js"
import * as Icons from "./icons.js"
import { UserColor } from "./utils/colors.js"

export default class PdfView extends Component {
  constructor(props) {
    super(props)
    this.state = {
      roomId: null,
      focus: null,
      totalPages: null,
      navHeight: 75,
      panelVisible: false,
      hasSelection: false,
      annotationsVisible: true,
      annotationContents: [],
      filteredAnnotationContents: [],
      pindropMode: null,
      annotationFilter: History.message?.searchString || "",
      searchString: "",
      loadingStatus: "loading...",
      pdfWidthPx: null,
      pdfHeightPx: null,
      pdfFitRatio: 1,
      zoomFactor: null,
      modalContent: null,
      pinching: false,
      hideButtons: false // this is for hiding the buttons, but only applies if the buttons overlap the chatbox
    }
    this.prevScrollTop = 0
    this.unreadCounts = {} // XXX Since we update by mutating, this doesn't belong in state
    this.checkForSelection = this.checkForSelection.bind(this)
    this.handleKeydown = this.handleKeydown.bind(this)
    this.handleTimeline = this.handleTimeline.bind(this)
    this.handleAccountData = this.handleAccountData.bind(this)
    this.handleStateUpdate = this.handleStateUpdate.bind(this)
    this.userColor = new UserColor(Client.client.getUserId())
    // need the `bind` here in order to pass a named function into the event
    // listener with the proper `this` reference
  }

  componentDidMount() {
    document.addEventListener("selectionchange", this.checkForSelection)
    document.addEventListener('keydown', this.handleKeydown)
    this.updateAnnotations()
    Client.client.on("Room.timeline", this.handleTimeline)
    Client.client.on("RoomState.events", this.handleStateUpdate)
    Client.client.on("Room.accountData", this.handleAccountData)
  }

  componentWillUnmount() {
    document.removeEventListener("selectionchange", this.checkForSelection)
    document.removeEventListener('keydown', this.handleKeydown)
    Client.client.off("Room.timeline", this.handleTimeline)
    Client.client.off("RoomState.events", this.handleStateUpdate)
    Client.client.off("Room.accountData", this.handleAccountData)
  }

  handleStateUpdate = e => {
    if (e.getRoomId() === this.state.roomId && e.getType() === spaceChild) {
      this.updateAnnotations()
    }
  }

  handleTimeline (_event, room) {
    // room is null if this is a notification timeline event
    if (room?.roomId in this.unreadCounts) {
      this.unreadCounts[room.roomId] = calculateUnread(room.roomId)
      this.updateAnnotations()
    }
  }

  handlePointerDown = e => {
    this.pointerCache.push(e)
    if (this.pointerCache.length === 2) {
      this.initialDistance = Math.abs(this.pointerCache[0].clientX - this.pointerCache[1].clientX)
      this.initialZoom = this.state.zoomFactor
      this.setState({pinching: true})
    }
  }

  handlePointerUp = e => {
    this.pointerCache = this.pointerCache.filter(pointerEv => pointerEv.pointerId !== e.pointerId)
    if (this.state.pinching && this.pointerCache.length !== 2) this.setState({pinching: false})
  }

  handlePointerMove = e => {
    // update cache
    this.pointerCache.forEach((pointerEvent, index) => {
      if (e.pointerId === pointerEvent.pointerId) this.pointerCache[index] = e
    })
    // if two fingers are down, see if we're pinching
    if (this.pointerCache.length === 2) {
      const touchDistance = Math.abs(this.pointerCache[0].clientX - this.pointerCache[1].clientX)
      this.setZoom(this.initialZoom * (touchDistance / this.initialDistance))
    }
  }

  handleWidgetScroll = e => {
    if (this.prevScrollTop < e.target.scrollTop && !this.state.hideButtons) this.setState({hideButtons: true})
    if (this.prevScrollTop > e.target.scrollTop && this.state.hideButtons) this.setState({hideButtons: false})
    this.prevScrollTop = e.target.scrollTop
  }

  handleAccountData = (e, room) => {
    if (room.roomId in this.unreadCounts) {
      this.unreadCounts[room.roomId] = calculateUnread(room.roomId)
      this.updateAnnotations()
    } else if (room.roomId === this.state.roomId && this.props.pageFocused && e.getType() === lastViewed) {
      const theContent = e.getContent()
      if (theContent.page !== this.props.pageFocused && theContent.deviceId !== Client.deviceId) {
        this.populateToast(
          <Fragment>
            <h3 id="toast-header">Hey!</h3>
            <div>Another device is viewing a different page.</div>
            <div style="margin-top:10px">
              <button
                onclick={_ => {
                  History.push(`/${this.props.pdfFocused}/${theContent.page}/`)
                  this.populateToast(null)
                }}
                class="styled-button">
                Jump to there →
              </button>
            </div>
          </Fragment>
        )
      }
    }
  }

  annotationLayer = createRef()

  textLayer = createRef()

  annotationLayerWrapper = createRef()

  documentView = createRef()

  contentContainer = createRef()

  pointerCache = []

  setNavHeight = px => this.setState({ navHeight: px })

  setId = id => {
    // sets the roomId after loading a PDF, and also tries to use that information to update the focus.
    this.setState({roomId: id}, _ => this.props.roomFocused
      ? this.focusByRoomId(this.props.roomFocused)
      : null)
  }

  startPindrop = _ => {
    setTimeout(_ => {
      this.setState({pindropMode: {}})
      document.addEventListener("click", this.releasePin)
    }, 200)
  }

  releasePin = e => {
    if (e.target === this.annotationLayer.current.base) {
      const theX = e.altKey
        ? Math.round((e.offsetX - 25) / 25) * 25
        : e.offsetX - 25
      const theY = e.altKey
        ? Math.round((e.offsetY - 25) / 25) * 25
        : e.offsetY - 25
      this.setState({pindropMode: {x: theX, y: theY} })
    } else {
      document.removeEventListener("click", this.releasePin)
      this.setState({pindropMode: null })
    }
  }

  commitPin = (theX, theY) => {
    const theDomain = Client.client.getDomain()
    if (this.state.pindropMode?.x) {
      Client.client.createRoom({
        visibility: "public",
        name: `pindrop on page ${this.props.pageFocused}`,
        initial_state: [{
          type: "m.room.join_rules",
          state_key: "",
          content: {join_rule: "public"}
        },
        {
          type: spaceParent, // we indicate that the current room is the parent
          content: {
            via: [theDomain]
          },
          state_key: this.state.roomId
        }
        ]
      }).then(roominfo => {
        // set child event in pdfRoom State
        const childContent = {
          via: [theDomain],
          [eventVersion]: {
            pageNumber: parseInt(this.props.pageFocused, 10),
            activityStatus: "pending",
            type: "pindrop",
            x: theX,
            y: theY,
            icon: "map-pin",
            roomId: roominfo.room_id,
            creator: Client.client.getUserId()
          }
        }
        Client.client
          .sendStateEvent(this.state.roomId, spaceChild, childContent, roominfo.room_id)
          .catch(e => alert(e))
        this.setFocus(childContent[eventVersion])
        this.setState({ panelVisible: true })
      }).then(_ => {
        document.removeEventListener("click", this.releasePin)
        this.setState({pindropMode: null })
      }).catch(e => alert(e))
    }
  }

  commitHighlight = _ => {
    const theSelection = window.getSelection()
    if (theSelection.isCollapsed) return
    const theRange = theSelection.getRangeAt(0)
    const theContents = Array.from(theRange.cloneContents().childNodes)
    const theSelectedText = theContents.map(child =>
      child.nodeType === 3 // Text node
        ? child.data
        : child.nodeType === 1 // Element Node
          ? child.innerText
          : "" ).join(' ').replace(/(.)-\s+/g, "$1") // join nodes with spaces, clean any linebreak dashes
    const theDomain = Client.client.getDomain()

    const clientRects = Layout.sanitizeRects(Array.from(theRange.getClientRects())
      .map(rect => Layout.rectRelativeTo(this.annotationLayerWrapper.current, rect, this.state.pdfFitRatio * this.state.zoomFactor)))
    const boundingClientRect = Layout.unionRects(clientRects)
    // TODO: room creation is a bit slow, might want to rework this slightly for responsiveness
    //
    // TODO: we should set room_alias_name and name object, in a useful way based on the selection
    Client.client.createRoom({
      visibility: "public",
      name: `highlighted passage on page ${this.props.pageFocused}`,
      topic: theSelectedText,
      initial_state: [{
        type: "m.room.join_rules",
        state_key: "",
        content: {join_rule: "public"}
      },
      {
        type: spaceParent, // we indicate that the current room is the parent
        content: {
          via: [theDomain]
        },
        state_key: this.state.roomId
      }
      ]
    }).then(roominfo => {
      // set child event in pdfRoom State
      theSelection.removeAllRanges()
      const childContent = {
        via: [theDomain],
        [eventVersion]: {
          pageNumber: parseInt(this.props.pageFocused, 10),
          activityStatus: "pending",
          type: "highlight",
          boundingClientRect: JSON.stringify(boundingClientRect),
          clientRects: JSON.stringify(clientRects),
          roomId: roominfo.room_id,
          creator: Client.client.getUserId(),
          selectedText: theSelectedText
        }
      }
      Client.client
        .sendStateEvent(this.state.roomId, spaceChild, childContent, roominfo.room_id)
        .catch(e => alert(e))
      this.setFocus(childContent[eventVersion])
      this.setState({ panelVisible: true })
    }).catch(e => alert(e))
  }

  setPdfDimensions = (pdfHeightPx, pdfWidthPx) => {
    const width = document.body.clientWidth
    const height = document.body.clientHeight - this.state.navHeight - 10
    const heightratio = height / pdfHeightPx
    const widthratio = width / pdfWidthPx
    const zoomFactor = this.state.zoomFactor || Math.max(Math.min(heightratio, widthratio, 5), 1)
    this.setState({pdfHeightPx, pdfWidthPx, zoomFactor})
  }

  setPdfFitRatio = pdfFitRatio => this.setState({pdfFitRatio})

  setPdfText = pdfText => { this.pdfText = pdfText }

  // XXX : will need to debounce eventually
  setAnnotationFilter = annotationFilter => this.setState(oldState => {
    return {
      annotationFilter,
      filteredAnnotationContents: this.filterAnnotations(annotationFilter, oldState.annotationContents)
    }
  })

  setTotalPages = totalPages => this.setState({totalPages})

  setPdfLoadingStatus = loadingStatus => this.setState({loadingStatus})

  setSearch = searchString => this.setState({searchString})

  clearFocus = _ => this.setState({focus: null})

  toggleAnnotations = _ => this.setState(oldState => {
    return { annotationsVisible: !oldState.annotationsVisible }
  })

  emptyModal = _ => this.setState({ modalContent: null })

  populateModal = s => this.setState({ modalContent: s })

  emptyToast = _ => this.setState({ toastContent: null })

  populateToast = s => this.setState({ toastContent: s })

  setZoom = zoomFactor => {
    if (zoomFactor < 1) this.setState({zoomFactor: 1})
    else {
      zoomFactor = Math.min(zoomFactor, 5)
      const unscaledInternalOffsetX = (this.contentContainer.current.clientWidth / 2)
      const scaledInternalOffsetX = ((this.contentContainer.current.clientWidth / 2) / this.state.zoomFactor) * zoomFactor
      const scaledLeft = (this.contentContainer.current.scrollLeft / this.state.zoomFactor) * zoomFactor
      const unscaledInternalOffsetY = (this.contentContainer.current.clientHeight / 2)
      const scaledInternalOffsetY = ((this.contentContainer.current.clientHeight / 2) / this.state.zoomFactor) * zoomFactor
      const scaledTop = (this.contentContainer.current.scrollTop / this.state.zoomFactor) * zoomFactor
      const newX = scaledLeft + scaledInternalOffsetX - unscaledInternalOffsetX
      const newY = scaledTop + scaledInternalOffsetY - unscaledInternalOffsetY
      this.contentContainer.current.scrollTo(newX, newY)
      this.setState({zoomFactor})
    }
  }

  focusByRoomId = roomId => {
    const theRoom = Client.client.getRoom(this.state.roomId) // the roomId here is for the PDF
    const theRoomState = theRoom.getLiveTimeline().getState(Matrix.EventTimeline.FORWARDS)
    const theAnnotation = theRoomState.getStateEvents(spaceChild, roomId)
    if (theAnnotation) {
      const focus = theAnnotation.getContent()[eventVersion]
      History.push(`/${this.props.pdfFocused}/${focus.pageNumber || this.props.pageFocused}/${roomId}`)
      this.setState({ focus, panelVisible: true, hideButtons: false })
    }
  }

  focusNextInArray = array => {
    let reachedFocus = !this.state.focus
    if (!array) return
    for (const annot of array) {
      const theId = annot[eventVersion].roomId
      if (reachedFocus) {
        this.focusByRoomId(theId)
        return
      }
      reachedFocus = this.state.focus.roomId === theId
    }
    this.focusByRoomId(array[0][eventVersion].roomId)
  }

  focusNext = _ => {
    this.focusNextInArray(this.state.filteredAnnotationContents)
  }

  focusPrev = _ => {
    const clone = [... this.state.filteredAnnotationContents]
    this.focusNextInArray(clone.reverse())
  }

  prevPage = _ => {
    if (this.props.pageFocused > 1) {
      History.push(`/${this.props.pdfFocused}/${parseInt(this.props.pageFocused, 10) - 1}/`)
      this.contentContainer.current.scrollTop = this.contentContainer.current.scrollHeight
    }
  }

  nextPage = _ => {
    if (this.props.pageFocused < this.state.totalPages) {
      History.push(`/${this.props.pdfFocused}/${parseInt(this.props.pageFocused, 10) + 1}/`)
      this.contentContainer.current.scrollTop = 0
    }
  }

  togglePanel = () => this.setState({panelVisible: !this.state.panelVisible})

  checkForSelection () {
    if (this.selectionTimeout) clearTimeout(this.selectionTimeout)
    const hasSelection = !window.getSelection().isCollapsed &&
                       this.textLayer.current.contains(window.getSelection().getRangeAt(0).endContainer) &&
                       this.textLayer.current.contains(window.getSelection().getRangeAt(0).startContainer)
    this.selectionTimeout = setTimeout(200, this.setState({hasSelection}))
    // timeout to avoid excessive rerendering
  }

  handleRouteChange = _ => {
    // sets the last viewed page for later retrieval
    if (!this.props.pageFocused || !this.props.pdfFocused || !this.state.roomId) return
    Client.client.setRoomAccountData(this.state.roomId, lastViewed, {
      page: this.props.pageFocused,
      deviceId: Client.deviceId
    })
    if (this.props.roomFocused) this.focusByRoomId(this.props.roomFocused)
  }

  handleKeydown = e => {
    if (e.altKey && e.key === 'a') this.openAnnotation()
    if (e.altKey && e.key === 'r') this.closeAnnotation()
    if (e.altKey && e.key === 'v') this.toggleAnnotations()
    if (e.ctrlKey || e.altKey || e.metaKey) return // Don't catch browser shortcuts
    if (e.key === '+' || e.key === '=') this.setZoom(this.state.zoomFactor + 0.1)
    if (e.key === '-') this.setZoom(this.state.zoomFactor - 0.1)
    if (e.key === "Esc" || e.key === "Escape") History.push("/")
    if (e.key === 'j' || e.key === "ArrowRight") this.nextPage()
    if (e.key === 'k' || e.key === "ArrowLeft") this.prevPage()
    if (e.key === "ArrowUp") {
      e.preventDefault() // block default scrolling behavior
      this.contentContainer.current.scroll({
        top: this.contentContainer.current.scrollTop - 100,
        left: this.contentContainer.current.scrollLeft
      })
    }
    if (e.key === "ArrowDown") {
      e.preventDefault() // block default scrolling behavior
      this.contentContainer.current.scroll({
        top: this.contentContainer.current.scrollTop + 100,
        left: this.contentContainer.current.scrollLeft
      })
    }
  }

  openAnnotation = _ => {
    this.setState({ annotationsVisible: true })
    if (this.state.pindropMode?.x) this.commitPin(this.state.pindropMode.x, this.state.pindropMode.y)
    else this.commitHighlight()
  }

  closeAnnotation = _ => {
    const theDomain = Client.client.getDomain()
    const isCreator = Client.client.getUserId() === this.state.focus.creator
    const theRoom = Client.client.getRoom(this.state.roomId)
    const isMod = theRoom.getMember(Client.client.getUserId()).powerLevel >= 50
    if (!confirm('Are you sure you want to close this annotation?')) return
    if (!isCreator && !isMod) {
      alert("Only moderators can close annotations that they didn't create")
      return
    }
    const theDiff = { activityStatus: "closed" }
    const theContent = {
      via: [theDomain],
      [eventVersion]: Object.assign(this.state.focus, theDiff)
    }
    Client.client.sendStateEvent(this.state.roomId, spaceChild, theContent, this.state.focus.roomId)
    this.unsetFocus()
  }

  unsetFocus = _ => {
    this.setState({focus: null})
    History.push(`/${this.props.pdfFocused}/${this.props.pageFocused}/`)
  }

  setFocus = (content) => {
    History.push(`/${this.props.pdfFocused}/${this.props.pageFocused}/${content.roomId}/`)
    this.setState({focus: content})
  }

  getLoadingStatus() {
    if (this.state.pdfHeightPx) return null
    if (typeof this.state.loadingStatus === "string") {
      return <div id="document-view-loading">{this.state.loadingStatus}</div>
    }
    if (typeof this.state.loadingStatus === "number") {
      return <div id="document-view-loading">Downloading Pdf...
          <progress class="styled-progress" max="1" value={this.state.loadingStatus} />
        </div>
    }
  }

  updateAnnotations = _ => {
    const theRoom = Client.client.getRoom(this.state.roomId)
    if (theRoom) {
      const annotationContents = theRoom.getLiveTimeline()
        .getState(Matrix.EventTimeline.FORWARDS).getStateEvents(spaceChild)
        .map(ev => {
          const content = ev.getContent()
          content.timestamp = ev.getTs()
          if (!(ev.getStateKey() in this.unreadCounts)) {
            this.unreadCounts[ev.getStateKey()] = calculateUnread(ev.getStateKey())
          }
          content.unread = this.unreadCounts[ev.getStateKey()]
          return content
        })
        .filter(content =>
          content[eventVersion] &&
          (!content[eventVersion].private || content.unread !== "All") && // we infer that you are a member if you have unread
          ( content[eventVersion].activityStatus === "open" ||
            ( content[eventVersion].activityStatus === "pending" &&
              content[eventVersion].creator === Client.client.getUserId()
            )
          )
        )
      this.setState({annotationContents, filteredAnnotationContents: this.filterAnnotations(this.state.annotationFilter, annotationContents)})
    } else setTimeout(this.updateAnnotations, 500) // keep polling until the room is available
  }

  filterAnnotations = (search, annotations) => {
    const searchText = []
    const searchMembers = []
    const searchFlags = []
    const searchWords = search.split(" ")
    for (const word of searchWords) {
      if (word.slice(0, 1) === '@') searchMembers.push(word.slice(1))
      else if (word.slice(0, 1) === '~') searchFlags.push(word.slice(1))
      else searchText.push(word)
    }
    return annotations.filter(content => {
      let flagged = true
      if (searchFlags.includes("me")) { flagged = flagged && content[eventVersion].creator === Client.client.getUserId() }
      if (searchFlags.includes("hour")) { flagged = flagged && (content.timestamp > (Date.now() - 3600000)) }
      if (searchFlags.includes("day")) { flagged = flagged && (content.timestamp > (Date.now() - 86400000)) }
      if (searchFlags.includes("week")) { flagged = flagged && (content.timestamp > (Date.now() - 604800000)) }
      if (searchFlags.includes("unread")) { flagged = flagged && content.unread }
      const membered = searchMembers.length
        ? searchMembers.some(member => content[eventVersion].creator.toLowerCase().includes(member.toLowerCase()))
        : true
      return membered && flagged && searchText.every(term =>
        (!content[eventVersion].selectedText && !content[eventVersion].rootContent) ||
        content[eventVersion].selectedText?.toLowerCase().includes(term.toLowerCase()) ||
        content[eventVersion].rootContent?.body.toLowerCase().includes(term.toLowerCase()))
    })
  }

  render(props, state) {
    const dynamicDocumentStyle = {
      "--pdfZoomFactor": state.zoomFactor,
      "--navHeight": `${state.navHeight}px`,
      "--pdfFitRatio": state.pdfFitRatio,
      "--pdfWidthPx": `${state.pdfWidthPx}px`,
      "--pdfHeightPx": `${state.pdfHeightPx}px`,
      "--sidePanelVisible": state.panelVisible ? 1 : 0,
      "--chatFocused": state.focus ? 1 : 0,
      "--selectColor": this.userColor.solid,
      "touch-action": this.state.pinching ? "none" : null
    }
    const hideUntilWidthAvailable = {
      visibility: state.pdfHeightPx ? null : "hidden"
    }
    const theRoom = Client.client.getRoom(state.roomId)
    return <div
      style={dynamicDocumentStyle}
      id="content-container"
      ref={this.contentContainer}
      onPointerDown={this.handlePointerDown}
      onPointerUp={this.handlePointerUp}
      onPointerCancel={this.handlePointerUp}
      onPointerLeave={this.handlePointerUp}
      data-pindrop-mode={state.pindropMode
        ? (state.pindropMode?.x && "placed") || "unplaced"
        : false
      }
      onPointerMove={this.handlePointerMove}>
      <Router onChange={this.handleRouteChange} />
      <Modal modalVisible={!!state.modalContent} hideModal={this.emptyModal}>{state.modalContent}</Modal>
      <Toast toastVisible={!!state.toastContent} hideToast={this.emptyToast}>{state.toastContent}</Toast>
      {this.getLoadingStatus()}
      <div style={hideUntilWidthAvailable} ref={this.documentView} id="document-view">
        <div id="document-wrapper" data-annotations-hidden={!state.annotationsVisible}>
          <PdfCanvas setPdfWidthPx={this.setPdfWidthPx}
            setPdfDimensions={this.setPdfDimensions}
            setPdfFitRatio={this.setPdfFitRatio}
            annotationLayer={this.annotationLayer}
            textLayer={this.textLayer}
            searchString={state.searchString}
            pdfFocused={props.pdfFocused}
            pageFocused={props.pageFocused}
            initFocus={this.initFocus}
            setId={this.setId}
            setTotalPages={this.setTotalPages}
            setPdfText={this.setPdfText}
            setPdfLoadingStatus={this.setPdfLoadingStatus}
          />
          <AnnotationLayer ref={this.annotationLayer}
                pindropMode={state.pindropMode}
                annotationLayer={this.annotationLayer}
                annotationLayerWrapper={this.annotationLayerWrapper}
                filteredAnnotationContents={state.filteredAnnotationContents}
                pdfWidthAdjusted={state.pdfWidthPx / state.pdfFitRatio}
                zoomFactor={state.zoomFactor}
                page={props.pageFocused}
                roomId={state.roomId}
                setFocus={this.setFocus}
                focus={state.focus}
          />
        </div>
      </div>
      <div id="sidepanel">
        {state.focus
          ? <Chat class="panel-widget-1"
              setFocus={this.setFocus}
              unsetFocus={this.unsetFocus}
              pdfId={state.roomId}
              populateModal={this.populateModal}
              handleWidgetScroll={this.handleWidgetScroll}
              focus={state.focus} />
          : null
        }
        { state.searchString
          ? <SearchResults
              class={state.focus ? "panel-widget-2" : "panel-widget-1"}
              searchString={state.searchString}
              setSearch={this.setSearch}
              pdfText={this.pdfText}
              pdfFocused={props.pdfFocused}
              roomFocused={props.roomFocused}
            />
          : <AnnotationListing
                roomId={state.roomId}
                class={state.focus ? "panel-widget-2" : "panel-widget-1"}
                focus={state.focus}
                setAnnotationFilter={this.setAnnotationFilter}
                annotationFilter={state.annotationFilter}
                annotationContents={state.annotationContents}
                filteredAnnotationContents={state.filteredAnnotationContents}
                handleWidgetScroll={this.handleWidgetScroll}
                focusByRoomId={this.focusByRoomId}
                focusNext={this.focusNext}
                focusPrev={this.focusPrev}
                unreadCounts={this.unreadCounts}
                room={theRoom}
              />
          }
      </div>
      <Navbar selected={state.hasSelection}
        openAnnotation={this.openAnnotation}
        closeAnnotation={this.closeAnnotation}
        pageFocused={props.pageFocused || 1}
        pdfFocused={props.pdfFocused}
        total={state.totalPages}
        focus={state.focus}
        roomId={state.roomId}
        focusNext={this.focusNext}
        focusPrev={this.focusPrev}
        nextPage={this.nextPage}
        prevPage={this.prevPage}
        searchString={state.searchString}
        pdfWidthPx={state.pdfWidthPx}
        populateModal={this.populateModal}
        annotationsVisible={state.annotationsVisible}
        toggleAnnotations={this.toggleAnnotations}
        setNavHeight={this.setNavHeight}
        setSearch={this.setSearch}
        startPindrop={this.startPindrop}
        pindropMode={state.pindropMode}
        setZoom={this.setZoom}
        zoomFactor={state.zoomFactor} />
      <div data-hide-buttons={state.hideButtons} id="pdf-panel-button-wrapper">
        {(state.panelVisible && state.focus)
          ? <button title="focus annotation list" id="show-annotations" onclick={this.clearFocus}>
            {Icons.list}
          </button>
          : null
        }
        <button title="toggle sidebar" id="panel-toggle" onclick={this.togglePanel}>
          {state.panelVisible ? Icons.close : Icons.menu }
        </button>
      </div>
      <SyncIndicator class={state.panelVisible ? null : "sync-hidden"} />
    </div>
  }
}
