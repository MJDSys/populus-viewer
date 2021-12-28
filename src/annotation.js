import { h, createRef, Component } from 'preact';
import * as Layout from "./layout.js"
import * as Matrix from "matrix-js-sdk"
import { spaceChild } from "./constants.js"
import { UserColor } from "./utils/colors.js"
import Client from './client.js'
import './styles/annotation-layer.css'
import * as Icons from './icons.js'

export default class AnnotationLayer extends Component {
  constructor(props) {
    super(props)
    this.state = {typing: {}}
    this.handleTypingNotification = this.handleTypingNotification.bind(this)
  }

  componentDidMount() {
    Client.client.on("RoomMember.typing", this.handleTypingNotification)
  }

  componentDidUnmount () {
    Client.client.off("RoomMember.typing", this.handleTypingNotification)
  }

  handleTypingNotification = (event, member) => {
    const theRoomState = Client.client.getRoom(this.props.roomId).getLiveTimeline().getState(Matrix.EventTimeline.FORWARDS)
    const theChildRelation = theRoomState.getStateEvents(spaceChild, member.roomId)
    // We use nested state here because we want to pass this part of the state to a child
    if (theChildRelation) {
      this.setState(prevState => {
        const myId = Client.client.getUserId()
        const typingOtherThanMe = event.getContent().user_ids.filter(x => x !== myId)
        return {typing: { ...prevState.typing, [member.roomId]: typingOtherThanMe}}
      })
    }
  }

  filterAnnotations (loc) {
    return (
      !!loc.location && // filter out old eventVersions
      loc.location.pageNumber === parseInt(this.props.pageFocused, 10) &&
      ( loc.location.activityStatus === "open" ||
        (loc.location.activityStatus === "pending" && loc.event.getSender() === Client.client.getUserId())
      )
    )
  }

  getAnnotations() {
    const theRoom = Client.client.getRoom(this.props.roomId)
    const focusId = this.props.focus?.getChild()
    let annotations = []
    if (theRoom) {
      let didFocus = false
      // We filter to include only the annotations on the page
      const annotationData = this.props.filteredAnnotationContents
        .filter(loc => {
          if (loc.getChild() === this.props.focus?.getChild()) didFocus = true
          return this.filterAnnotations(loc)
        })
      // We add the focus back in if it's on the page but got screened out of filteredAnnotationContents
      if (this.props.focus && this.filterAnnotations(this.props.focus) && !didFocus) annotationData.push(this.props.focus)
      // We turn the array into annontation components
      annotations = annotationData.map(loc => {
        const annotationId = loc.getChild()
        switch (loc.location.type) {
          case 'pindrop': return <Pindrop
            key={annotationId}
            focused={focusId === annotationId}
            typing={this.state.typing[annotationId]}
            setFocus={this.props.setFocus}
            location={loc} />
          // default for legacy reasons, could switch to highlight in 2022
          default: return <Annotation
            zoomFactor={this.props.zoomFactor}
            key={annotationId}
            focused={focusId === annotationId}
            typing={this.state.typing[annotationId]}
            setFocus={this.props.setFocus}
            pdfWidthAdjusted={this.props.pdfWidthAdjusted}
            location={loc} />
        }
      })
    }
    return annotations
  }

  render(props) {
    return (
      <div
        ref={props.annotationLayerWrapper}
        data-annotation-focused={!!props.focus}
        id="annotation-layer">
        {this.getAnnotations()}
        {props.pindropMode?.x ? <PindropPreview coordinates={props.pindropMode} /> : null}
      </div>
    )
  }
}

function PindropPreview (props) {
  const style = {
    left: `${props.coordinates.x}px`,
    top: `${props.coordinates.y}px`
  }
  return <span
    class="annotation-pindrop annotation-pindrop-preview"
    data-annotation
    style={style}>
    {Icons.pin}
  </span>
}

class Pindrop extends Component {
  setFocus = _ => this.props.setFocus(this.props.location)

  userColor = new UserColor(this.props.location.location.creator)

  style = {
    left: `${this.props.location.location.x}px`,
    top: `${this.props.location.location.y}px`,
    ...this.userColor.styleVariables
  }
  // we add a slight 15px offset to have it line up more with the cursor

  render(props) {
    const typing = typeof (props.typing) === "object" && Object.keys(props.typing).length > 0 ? true : null
    return <span
      onclick={this.setFocus}
      class="annotation-pindrop"
      data-focused={props.focused}
      data-annotation-typing={typing}
      data-annotation
      style={this.style}>
      {Icons.pin}
    </span>
  }
}

class Annotation extends Component {

  shouldComponentUpdate(nextProps) {
    if (nextProps.pdfWidthAdjusted === 0) return false
    if (!this.positioned && nextProps.pdfWidthAdjusted > this.boundingRect.width * 2) {
      const rightMargin = nextProps.pdfWidthAdjusted - (this.boundingRect.width + this.boundingRect.x)
      if (rightMargin < this.boundingRect.x) this.rightSide = true
      if (rightMargin > this.boundingRect.x) this.rightSide = false
      this.positioned = true //don't recalculate after positioning
    }
  }

  setFocus = _ => { this.props.setFocus(this.props.location) }

  eventContent = this.props.location.location

  roomId = this.props.location.getChild()

  rightSide = this.roomId.charCodeAt(1) % 2 === 1

  positioned = false // whether we've manually positioned the bartab.

  boundingRect = JSON.parse(this.eventContent.boundingClientRect)

  userColor = new UserColor(this.eventContent.creator)

  render(props) {
    if (props.pdfWidthAdjusted === 0) return null
    // This is recalculated with every render. Could be memoized on pdfWidthAdjusted and zoomfactor
    const spans = JSON.parse(this.eventContent.clientRects).map(
      rect => <RectSpan pdfWidthAdjusted={this.props.pdfWidthAdjusted} key={rect} zoomFactor={this.props.zoomFactor} setFocus={this.setFocus} rect={rect} />
    )
    const typing = typeof (props.typing) === "object" && Object.keys(props.typing).length > 0 ? true : null
    return <div style={this.userColor.styleVariables} data-annotation-typing={typing} data-focused={props.focused} id={this.roomId}>
      <BarTab
        pdfWidthAdjusted={props.pdfWidthAdjusted}
        rightSide={this.rightSide}
        rect={this.boundingRect}
        zoomFactor={props.zoomFactor}
        setFocus={this.setFocus} />
      <div class="inline-annotations">
        {spans}
      </div>
    </div>
  }
}

class BarTab extends Component {
  constructor(props) {
    super(props)
    this.state = {
      overlapOffset: 0
    }
  }

  componentDidMount() {
    Layout.positionRelativeAt(this.getTabRect(), this.ref.current, 1)
    this.scootch()
  }

  componentDidUpdate() {
    Layout.positionRelativeAt(this.getTabRect(), this.ref.current, this.props.zoomFactor)
    this.scootch()
  }

  ref = createRef()

  getTabRect = _ => {
    return this.props.rightSide
      ? new DOMRect(this.props.pdfWidthAdjusted - 10 + this.state.overlapOffset, this.props.rect.y, 5, this.props.rect.height)
      : new DOMRect(5 - this.state.overlapOffset, this.props.rect.y, 5, this.props.rect.height)
  }

  scootch = _ => {
    const rect = this.ref.current.getBoundingClientRect()
    const overlaps = document.elementsFromPoint(rect.x + 1, rect.y + 1)
      .filter(elt => {
        const eltRect = elt.getBoundingClientRect()
        const isAnnot = elt.className === "annotation-bartab"
        const isPrior = elt.compareDocumentPosition(this.ref.current) === 4
        return (isAnnot && ((eltRect.y < rect.y) || (isPrior && eltRect.y === rect.y)))
      })
    if (overlaps.length > 0) {
      this.setState({overlapOffset: this.state.overlapOffset + 10})
    }
  }

  render(props) {
    return <span
      onclick={props.setFocus}
      class="annotation-bartab"
      data-annotation
      ref={this.ref}
    />
  }
}

class RectSpan extends Component {
  ref = createRef()

  componentDidMount() { 
    Layout.positionRelativeAt(this.props.rect, this.ref.current, this.props.zoomFactor) 
  }

  componentDidUpdate() { 
    Layout.positionRelativeAt(this.props.rect, this.ref.current, this.props.zoomFactor) 
  }

  render(props) {
    return <span onclick={props.setFocus} data-annotation ref={this.ref} />
  }
}
