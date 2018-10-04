/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import mapboxgl from 'mapbox-gl';
import React from 'react';
import ReactDOM from 'react-dom';

import { ALayer } from './layer';
import { VectorStyle } from './styles/vector_style';
import { LeftInnerJoin } from './joins/left_inner_join';

import { FeatureTooltip } from 'plugins/gis/components/map/feature_tooltip';

const DEFAULT_COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#f58231', '#911eb4'];
let defaultColorIndex = 0;

export class VectorLayer extends ALayer {

  static type = 'VECTOR';

  static popup = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: 'euiPanel euiPanel--shadow',
  });

  static tooltipContainer = document.createElement('div');

  static createDescriptor(options) {
    const layerDescriptor = super.createDescriptor(options);
    layerDescriptor.type = VectorLayer.type;
    defaultColorIndex = defaultColorIndex  % DEFAULT_COLORS.length;
    if (!options.style) {
      layerDescriptor.style = VectorStyle.createDescriptor({
        'fillColor': {
          type: VectorStyle.STYLE_TYPE.STATIC,
          options: {
            color: DEFAULT_COLORS[defaultColorIndex++]
          }
        }
      });
    }
    return layerDescriptor;
  }

  constructor(options) {
    super(options);
    this._joins =  [];
    if (options.layerDescriptor.joins) {
      options.layerDescriptor.joins.forEach((joinDescriptor) => {
        this._joins.push(new LeftInnerJoin(joinDescriptor));
      });
    }
  }

  isJoinable() {
    return true;
  }

  getSupportedStyles() {
    return [VectorStyle];
  }

  async getStringFields() {
    return await this._source.getStringFields();
  }

  async getOrdinalFields() {

    const numberFields = await this._source.getNumberFields();
    const numberFieldOptions = numberFields.map(name => {
      return { label: name, origin: 'source' };
    });
    const joinFields = this._joins.map(join => {
      return {
        label: join.displayHash(),
        origin: 'join',
        join: join
      };
    });

    return numberFieldOptions.concat(joinFields);
  }

  async _canSkipSourceUpdate(source, sourceDataId) {
    const timeAware = await source.isTimeAware();
    const extentAware = source.isFilterByMapBounds();
    if (!timeAware && !extentAware) {
      const sourceDataRequest = this._dataRequests.find(dataRequest => dataRequest.getDataId() === sourceDataId);
      if (sourceDataRequest && sourceDataRequest.hasDataOrRequestInProgress()) {
        return true;
      }
    }
    return false;
  }

  async _syncJoin(join, { startLoading, stopLoading, onLoadError, dataFilters }) {

    const tableSource = join.getTableSource();
    const sourceDataId = join.getSourceId();
    const requestToken = Symbol(`layer-join-refresh:${ this.getId()} - ${sourceDataId}`);

    try {
      const canSkip = await this._canSkipSourceUpdate(tableSource, sourceDataId);
      if (canSkip) {
        return;
      }
      startLoading(sourceDataId, requestToken, { timeFilters: dataFilters.timeFilters });
      const data = await tableSource.getTable(dataFilters);
      stopLoading(sourceDataId, requestToken, data);
    } catch(e) {
      onLoadError(sourceDataId, requestToken, e.medium);
    }
  }


  async _syncJoins({ startLoading, stopLoading, onLoadError, dataFilters }) {
    const joinSyncs = this._joins.map(async join => {
      return this._syncJoin(join, { startLoading, stopLoading, onLoadError, dataFilters });
    });
    await Promise.all(joinSyncs);
  }


  async _syncSource({ startLoading, stopLoading, onLoadError, dataFilters }) {
    const sourceDataId = 'source';
    const requestToken = Symbol(`layer-source-refresh:${ this.getId()} - source`);
    try {

      const canSkip = await this._canSkipSourceUpdate(this._source, sourceDataId);
      if (canSkip) {
        return;
      }

      startLoading(sourceDataId, requestToken, { timeFilters: dataFilters.timeFilters });
      const data = await this._source.getGeoJson({
        layerId: this.getId(),
        layerName: this.getDisplayName()
      }, dataFilters);
      stopLoading(sourceDataId, requestToken, data);

    } catch (error) {
      onLoadError(sourceDataId, requestToken, error.message);
    }
  }

  async getJoinDataRequests() {

    const joinDataRequests = this._dataRequests.filter(dataRequest => {
      const correspondingJoin = this._joins.find(join => {
        return join.getSourceId() === dataRequest.getDataId();
      });
      return !!correspondingJoin;
    });
    return joinDataRequests;
  }

  async syncData({ startLoading, stopLoading, onLoadError, dataFilters }) {

    if (!this.isVisible() || !this.showAtZoomLevel(dataFilters.zoom)) {
      return;
    }
    //todo: could parallelize this, but this avoids dealing with some race-conditions
    await this._syncSource({ startLoading, stopLoading, onLoadError, dataFilters });
    await this._syncJoins({ startLoading, stopLoading, onLoadError, dataFilters });
  }


  _getSourceFeatureCollection() {
    const sourceDataRequest = this.getSourceDataRequest();
    return sourceDataRequest ? sourceDataRequest.getData() : null;
  }

  _isPointsOnly() {
    const featureCollection = this._getSourceFeatureCollection();
    let isPointsOnly = true;
    if (featureCollection) {
      for (let i = 0; i < featureCollection.features.length; i++) {
        if (featureCollection.features[i].geometry.type !== 'Point') {
          isPointsOnly = false;
          break;
        }
      }
    } else {
      isPointsOnly = false;
    }
    return isPointsOnly;
  }

  _syncFeatureCollectionWithMb(mbMap) {
    const featureCollection = this._getSourceFeatureCollection();
    const mbSourceAfterAdding = mbMap.getSource(this.getId());
    if (featureCollection !== mbSourceAfterAdding._data) {
      mbSourceAfterAdding.setData(featureCollection);
    }
    const shouldRefresh = this._style.enrichFeatureCollectionWithScaledProps(featureCollection);
    if (shouldRefresh) {
      mbSourceAfterAdding.setData(featureCollection);
    }
  }

  syncLayerWithMB(mbMap) {

    const mbSource = mbMap.getSource(this.getId());
    if (!mbSource) {
      //todo: hack, but want to get some quick visual indication for points data
      //cannot map single kibana layer to single mapbox source
      mbMap.addSource(this.getId(), {
        type: 'geojson',
        data: { 'type': 'FeatureCollection', 'features': [] }
      });
    }



    this._syncFeatureCollectionWithMb(mbMap);

    const isPointsOnly = this._isPointsOnly();
    if (isPointsOnly) {
      const pointLayerId = this.getId() +  '_circle';
      this._style.setMBPaintPropertiesForPoints(mbMap, this.getId(), pointLayerId, this.isTemporary());
      mbMap.setLayoutProperty(pointLayerId, 'visibility', this.isVisible() ? 'visible' : 'none');
      if (!this._descriptor.showAtAllZoomLevels) {
        mbMap.setLayerZoomRange(pointLayerId, this._descriptor.minZoom, this._descriptor.maxZoom);
      }
      this.addToolipListeners(mbMap, pointLayerId);
    } else {
      const fillLayerId = this.getId() + '_fill';
      const strokeLayerId = this.getId() + '_line';
      this._style.setMBPaintProperties(mbMap, this.getId(), fillLayerId, strokeLayerId, this.isTemporary());
      mbMap.setLayoutProperty(fillLayerId, 'visibility', this.isVisible() ? 'visible' : 'none');
      mbMap.setLayoutProperty(strokeLayerId, 'visibility', this.isVisible() ? 'visible' : 'none');
      if (!this._descriptor.showAtAllZoomLevels) {
        mbMap.setLayerZoomRange(strokeLayerId, this._descriptor.minZoom, this._descriptor.maxZoom);
        mbMap.setLayerZoomRange(fillLayerId, this._descriptor.minZoom, this._descriptor.maxZoom);
      }
      this.addToolipListeners(mbMap, fillLayerId);
    }
  }

  renderStyleEditor(style, options) {
    return style.renderEditor({
      layer: this,
      ...options
    });
  }

  addToolipListeners(mbMap, mbLayerId) {
    this.removeAllListenersForMbLayer(mbMap, mbLayerId);

    if (!this._source.areFeatureTooltipsEnabled()) {
      return;
    }

    this.addEventListenerForMbLayer(mbMap, mbLayerId, 'mouseenter', async (e) => {
      mbMap.getCanvas().style.cursor = 'pointer';

      const feature = e.features[0];

      let popupAnchorLocation = e.lngLat; // default popup location to mouse location
      if (feature.geometry.type === 'Point') {
        const coordinates = e.features[0].geometry.coordinates.slice();

        // Ensure that if the map is zoomed out such that multiple
        // copies of the feature are visible, the popup appears
        // over the copy being pointed to.
        while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
          coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
        }

        popupAnchorLocation = coordinates;
      }

      const properties = await this._source.filterAndFormatProperties(e.features[0].properties);

      ReactDOM.render(
        React.createElement(
          FeatureTooltip, {
            properties: properties,
          }
        ),
        VectorLayer.tooltipContainer
      );

      VectorLayer.popup.setLngLat(popupAnchorLocation)
        .setDOMContent(VectorLayer.tooltipContainer)
        .addTo(mbMap);
    });

    this.addEventListenerForMbLayer(mbMap, mbLayerId, 'mouseleave', () => {
      mbMap.getCanvas().style.cursor = '';
      VectorLayer.popup.remove();
      ReactDOM.unmountComponentAtNode(VectorLayer.tooltipContainer);
    });
  }
}
