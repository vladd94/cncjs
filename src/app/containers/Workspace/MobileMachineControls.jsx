import React, { PureComponent } from 'react';
import controller from 'app/lib/controller';
import i18n from 'app/lib/i18n';
import styles from './MobileMachineControls.styl';

class MobileMachineControls extends PureComponent {
  command = {
    homing: () => {
      controller.command('homing');
    },
    sleep: () => {
      controller.command('sleep');
    },
    unlock: () => {
      controller.command('unlock');
    },
    reset: () => {
      controller.command('reset');
    },
  };

  render() {
    return (
      <div
        className={styles.machineBar}
        role="toolbar"
        aria-label={i18n._('Machine controls')}
      >
        <button
          type="button"
          className={`${styles.machineBtn} ${styles.homing}`}
          onClick={this.command.homing}
        >
          <i aria-hidden="true" className="fa fa-home" />
          <span>{i18n._('Homing')}</span>
        </button>
        <button
          type="button"
          className={`${styles.machineBtn} ${styles.sleep}`}
          onClick={this.command.sleep}
        >
          <i aria-hidden="true" className="fa fa-bed" />
          <span>{i18n._('Sleep')}</span>
        </button>
        <button
          type="button"
          className={`${styles.machineBtn} ${styles.unlock}`}
          onClick={this.command.unlock}
        >
          <i aria-hidden="true" className="fa fa-unlock-alt" />
          <span>{i18n._('Unlock')}</span>
        </button>
        <button
          type="button"
          className={`${styles.machineBtn} ${styles.reset}`}
          onClick={this.command.reset}
        >
          <i aria-hidden="true" className="fa fa-undo" />
          <span>{i18n._('Reset')}</span>
        </button>
      </div>
    );
  }
}

export default MobileMachineControls;
