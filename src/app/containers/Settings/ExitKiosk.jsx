import React, { PureComponent } from 'react';
import api from 'app/api';
import { Button } from 'app/components/Buttons';
import Modal from 'app/components/Modal';
import ModalTemplate from 'app/components/ModalTemplate';
import { WORKFLOW_STATE_RUNNING } from 'app/constants';
import controller from 'app/lib/controller';
import i18n from 'app/lib/i18n';
import styles from './index.styl';

class ExitKiosk extends PureComponent {
  state = {
    open: false,
    exiting: false,
    error: false,
    jobRunning: false
  };

  componentDidMount() {
    this.onWorkflowState = (workflowState) => {
      this.setState({ jobRunning: workflowState === WORKFLOW_STATE_RUNNING });
    };
    controller.addListener('workflow:state', this.onWorkflowState);
    this.onWorkflowState(controller.workflow.state);
  }

  componentWillUnmount() {
    controller.removeListener('workflow:state', this.onWorkflowState);
  }

  openDialog = () => {
    this.setState({
      open: true,
      exiting: false,
      error: false,
      jobRunning: controller.workflow.state === WORKFLOW_STATE_RUNNING
    });
  };

  closeDialog = () => {
    if (this.state.exiting) {
      return;
    }
    this.setState({ open: false, error: false });
  };

  confirmExit = () => {
    this.setState({ exiting: true, error: false });
    api.exitKiosk()
      .then(() => {
        this.setState({ exiting: true, error: false });
      })
      .catch(() => {
        this.setState({ exiting: false, error: true });
      });
  };

  render() {
    const { open, exiting, error, jobRunning } = this.state;

    return (
      <div>
        <button
          type="button"
          className={styles.exitKioskButton}
          onClick={this.openDialog}
        >
          {i18n._('Exit to Desktop')}
        </button>
        {open && (
          <Modal disableOverlay size="sm" onClose={this.closeDialog}>
            <Modal.Header>
              <Modal.Title>
                {i18n._('Exit to Desktop')}
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <ModalTemplate type="warning">
                <p>{i18n._('Exit CNCjs and return to the desktop?')}</p>
                {jobRunning && (
                  <p>{i18n._('A CNC job is currently running. Closing the display will not stop the job.')}</p>
                )}
                {exiting && (
                  <p>{i18n._('Returning to desktop...')}</p>
                )}
                {error && (
                  <p>{i18n._('Could not exit kiosk mode.')}</p>
                )}
              </ModalTemplate>
            </Modal.Body>
            <Modal.Footer>
              <Button
                btnStyle="flat"
                disabled={exiting}
                onClick={this.closeDialog}
              >
                {i18n._('Cancel')}
              </Button>
              <Button
                btnStyle="danger"
                disabled={exiting}
                onClick={this.confirmExit}
              >
                {i18n._('Exit to Desktop')}
              </Button>
            </Modal.Footer>
          </Modal>
        )}
      </div>
    );
  }
}

export default ExitKiosk;
