import PropTypes from 'prop-types';
import React from 'react';
import i18n from 'app/lib/i18n';
import styles from './LandingView.styl';

const LandingView = ({ actions }) => {
  return (
    <div className={styles.landingView}>
      <div className={styles.intro}>
        <div className={styles.kicker}>{i18n._('Autolevel')}</div>
        <h3 className={styles.headline}>{i18n._('Map the surface, then correct the cut')}</h3>
        <p className={styles.lede}>
          {i18n._('Probe a height map or load one you already saved, then apply compensation to a linear G-code file.')}
        </p>
      </div>

      <button
        type="button"
        className={styles.pathCard}
        onClick={actions.startNewProbe}
      >
        <div className={styles.pathMeta}>
          <div className={styles.pathTitle}>{i18n._('Probe new surface')}</div>
          <div className={styles.pathDescription}>
            {i18n._('Set the probe area and capture a height map for this fixture.')}
          </div>
        </div>
        <span className={styles.pathAction} aria-hidden="true">→</span>
      </button>

      <button
        type="button"
        className={styles.pathCard}
        onClick={actions.loadProbeFile}
      >
        <div className={styles.pathMeta}>
          <div className={styles.pathTitle}>{i18n._('Apply compensation')}</div>
          <div className={styles.pathDescription}>
            {i18n._('Load a probe map and correct G-code before you cut.')}
          </div>
        </div>
        <span className={styles.pathAction} aria-hidden="true">→</span>
      </button>
    </div>
  );
};

LandingView.propTypes = {
  actions: PropTypes.object.isRequired,
};

export default LandingView;
