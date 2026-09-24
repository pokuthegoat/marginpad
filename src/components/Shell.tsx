import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import SceneBackground from '../scene/SceneBackground'
import SmoothScroll from './SmoothScroll'
import ConnectWallet from './ConnectWallet'
import { useAccount } from './account/AccountProvider'
import { scrollToSection, smoothScrollTo } from '../lib/smooth-scroll'
import { fmtEth } from '../store/format'
import { useStore } from '../store/StoreContext'

/**
 * Shared layout: the scene background (live on the landing page, one still frame elsewhere),
 * the centered nav and the shared wallet chip.
 */
export default function Shell() {
  const { pathname } = useLocation()
  const { state } = useStore()
  const { account } = useAccount()
  const landing = pathname === '/'
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    // Client-side navigation keeps the scroll position, so start each page at the top.
    if (!window.location.hash) window.scrollTo(0, 0)
  }, [pathname])

  return (
    <>
      <SmoothScroll />
      <SceneBackground dim={!landing} />
      <div className="page">
        <header className={scrolled ? 'nav is-scrolled' : 'nav'}>
          <Link
            className="logo"
            to="/"
            onClick={(e) => {
              // Already on the landing page: a link to the same route does nothing, so glide to the top instead.
              if (pathname !== '/') return
              e.preventDefault()
              if (!smoothScrollTo(0)) window.scrollTo({ top: 0, behavior: 'auto' })
            }}
          >
            <span className="logo-mark" aria-hidden="true">
              M
            </span>
            Marginpad
          </Link>
          <nav className="nav-pill" aria-label="Main">
            <NavLink to="/" end className="only-mobile">
              Home
            </NavLink>
            {landing && (
              <a
                className="only-desktop"
                href="#how"
                onClick={(e) => {
                  if (scrollToSection('how')) e.preventDefault()
                }}
              >
                How it works
              </a>
            )}
            {landing && (
              <a
                className="only-desktop"
                href="#who"
                onClick={(e) => {
                  if (scrollToSection('who')) e.preventDefault()
                }}
              >
                Who it’s for
              </a>
            )}
            <NavLink to="/trade">Trade</NavLink>
            <NavLink to="/pool">Pool</NavLink>
            {account?.setupComplete && <NavLink to="/dashboard">Dashboard</NavLink>}
          </nav>
          <div className="nav-right">
            <div className="wallet" title="Your testnet ETH balance">
              <span>Testnet</span>
              <b className="num">{fmtEth(state.wallet)}</b>
            </div>
            <ConnectWallet />
          </div>
        </header>
        <Outlet />
      </div>
    </>
  )
}
