import classNames from 'classnames';
import React, { PureComponent } from 'react';
import { Link, withRouter } from 'react-router-dom';
import i18n from 'app/lib/i18n';
import styles from './index.styl';

class Sidebar extends PureComponent {
    static propTypes = {
      ...withRouter.propTypes
    };

    render() {
      const { pathname = '' } = this.props.location;

      return (
        <nav aria-label="Main navigation" className={styles.navbar}>
          <ul className={styles.nav}>
            <li
              className={classNames(
                'text-center',
                { [styles.active]: pathname.indexOf('/workspace') === 0 }
              )}
            >
              <Link
                aria-label="Workspace"
                to="/workspace"
                title={i18n._('Workspace')}
                className={styles.navLink}
              >
                <i
                  aria-hidden="true"
                  className={classNames(
                    styles.icon,
                    styles.iconInvert,
                    styles.iconXyz
                  )}
                />
                <span className={styles.label}>{i18n._('Workspace')}</span>
              </Link>
            </li>
            <li
              className={classNames(
                'text-center',
                { [styles.active]: pathname.indexOf('/settings') === 0 }
              )}
            >
              <Link
                aria-label="Settings"
                to="/settings"
                title={i18n._('Settings')}
                className={styles.navLink}
              >
                <i
                  aria-hidden="true"
                  className={classNames(
                    styles.icon,
                    styles.iconInvert,
                    styles.iconGear
                  )}
                />
                <span className={styles.label}>{i18n._('Settings')}</span>
              </Link>
            </li>
          </ul>
        </nav>
      );
    }
}

export default withRouter(Sidebar);
