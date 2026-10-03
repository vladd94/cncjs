import React, { PureComponent } from 'react';
import { Redirect, withRouter } from 'react-router-dom';
import { trackPage } from '../lib/analytics';
import Header from './Header';
import Sidebar from './Sidebar';
import Workspace from './Workspace';
import Settings from './Settings';
import styles from './App.styl';

const MOBILE_LAYOUT_MQ = '(max-width: 1100px)';

class App extends PureComponent {
    static propTypes = {
      ...withRouter.propTypes
    };

    componentDidMount() {
      this.syncMobileLayoutClass();
      if (typeof window.matchMedia === 'function') {
        this.mobileLayoutMql = window.matchMedia(MOBILE_LAYOUT_MQ);
        if (this.mobileLayoutMql.addEventListener) {
          this.mobileLayoutMql.addEventListener('change', this.syncMobileLayoutClass);
        } else if (this.mobileLayoutMql.addListener) {
          this.mobileLayoutMql.addListener(this.syncMobileLayoutClass);
        }
      } else {
        window.addEventListener('resize', this.syncMobileLayoutClass);
      }
    }

    componentWillUnmount() {
      if (this.mobileLayoutMql) {
        if (this.mobileLayoutMql.removeEventListener) {
          this.mobileLayoutMql.removeEventListener('change', this.syncMobileLayoutClass);
        } else if (this.mobileLayoutMql.removeListener) {
          this.mobileLayoutMql.removeListener(this.syncMobileLayoutClass);
        }
      } else {
        window.removeEventListener('resize', this.syncMobileLayoutClass);
      }
      document.documentElement.classList.remove('cncjs-mobile');
    }

    syncMobileLayoutClass = () => {
      const isMobile = typeof window.matchMedia === 'function'
        ? window.matchMedia(MOBILE_LAYOUT_MQ).matches
        : window.innerWidth <= 1100;
      document.documentElement.classList.toggle('cncjs-mobile', isMobile);
    };

    render() {
      const { location } = this.props;
      const accepted = ([
        '/workspace',
        '/settings',
        '/settings/general',
        '/settings/workspace',
        '/settings/machine-profiles',
        '/settings/user-accounts',
        '/settings/controller',
        '/settings/commands',
        '/settings/events',
        '/settings/about'
      ].indexOf(location.pathname) >= 0);

      if (!accepted) {
        return (
          <Redirect
            to={{
              pathname: '/workspace',
              state: {
                from: location
              }
            }}
          />
        );
      }

      trackPage(location.pathname);

      return (
        <div className={styles.appShell}>
          <Header {...this.props} />
          <aside className={styles.sidebar} id="sidebar">
            <Sidebar {...this.props} />
          </aside>
          <div role="main" className={styles.main}>
            <div className={styles.content}>
              <Workspace
                {...this.props}
                style={{
                  display: (location.pathname !== '/workspace') ? 'none' : 'block'
                }}
              />
              {location.pathname.indexOf('/settings') === 0 &&
                <Settings {...this.props} />}
            </div>
          </div>
        </div>
      );
    }
}

export default withRouter(App);
