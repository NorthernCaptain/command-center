/**
 * Copyright NorthernCaptain, 2026
 * MIT license.
 */

import { Component } from "react"
import Link from "./Link.jsx"
import { EmptyState } from "./Skeleton.jsx"

/**
 * Catches render errors below it and shows a recoverable message instead of
 * unmounting the whole app. Resets when `resetKey` changes (e.g. the route)
 * or on "Try again".
 */
export default class ErrorBoundary extends Component {
    constructor(props) {
        super(props)
        this.state = { error: null, key: props.resetKey }
        this.reset = this.reset.bind(this)
    }

    static getDerivedStateFromError(error) {
        return { error }
    }

    static getDerivedStateFromProps(props, state) {
        if (props.resetKey !== state.key)
            return { error: null, key: props.resetKey }
        return null
    }

    componentDidCatch(error, info) {
        if (typeof console !== "undefined" && console.error)
            console.error("Render error", error, info && info.componentStack)
    }

    reset() {
        this.setState({ error: null })
    }

    render() {
        const { error } = this.state
        if (!error) return this.props.children
        return (
            <div className="page" role="alert">
                <EmptyState title="Something went wrong" glyph="!">
                    <p>{(error && error.message) || String(error)}</p>
                    <div className="row-gap">
                        <button
                            type="button"
                            className="btn"
                            onClick={this.reset}
                        >
                            Try again
                        </button>
                        <Link to="/" className="btn btn-ghost">
                            Back to board
                        </Link>
                    </div>
                </EmptyState>
            </div>
        )
    }
}
