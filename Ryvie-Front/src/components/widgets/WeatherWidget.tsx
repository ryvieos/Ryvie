import React from 'react';
import BaseWidget from './BaseWidget';
import WidgetRemoveButton from './WidgetRemoveButton';
import '../../styles/widgets/WeatherWidget.css';

interface WeatherData {
  location?: string;
  temperature?: number;
  humidity?: number;
  wind?: number;
  icon?: string;
}

interface WeatherWidgetProps {
  id?: string;
  weather: WeatherData;
  weatherImages: Record<string, string>;
  weatherIcons: Record<string, string>;
  weatherCity?: string;
  onRemove?: () => void;
  onClick?: () => void;
}

const WeatherWidget = ({
  id = 'weather',
  weather,
  weatherImages,
  weatherIcons,
  weatherCity,
  onRemove,
  onClick
}: WeatherWidgetProps) => {
  const bgSrc = weather.icon ? weatherImages[`./${weather.icon}`] : undefined;

  return (
    <BaseWidget
      id={id}
      w={3}
      h={2}
      className="weather-widget-base"
      onClick={onClick ?? null}
    >
      <div
        className="weather-card"
        style={{
          backgroundImage: bgSrc
            ? `url(${bgSrc})`
            : 'linear-gradient(135deg, rgba(100, 180, 255, 0.9), rgba(80, 150, 255, 0.9))'
        }}
      >
        {onRemove && <WidgetRemoveButton id={id} onRemove={() => onRemove()} className="weather-widget-remove" />}
        <div className="weather-content">
          <div className="weather-city">
            {weather.location || weatherCity || 'Localisation...'}
          </div>
          <div className="weather-temp">
            {weather.temperature ? `${Math.round(weather.temperature)}°C` : '...'}
          </div>
          <div className="weather-details">
            <div className="weather-humidity">
              {weatherIcons['./humidity.png'] && (
                <img src={weatherIcons['./humidity.png']} alt="Humidité" />
              )}
              {weather.humidity ? `${weather.humidity}%` : '...'}
            </div>
            <div className="weather-wind">
              {weatherIcons['./wind.png'] && (
                <img src={weatherIcons['./wind.png']} alt="Vent" />
              )}
              {weather.wind ? `${Math.round(weather.wind)} km/h` : '...'}
            </div>
          </div>
        </div>
      </div>
    </BaseWidget>
  );
};

export default WeatherWidget;
